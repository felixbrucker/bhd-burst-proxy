const io = require('socket.io-client');
const { hostname } = require('os');
const EventEmitter = require('events');
const database = require('../../models');
const eventBus = require('../services/event-bus');
const MiningInfo = require('../miningInfo');
const util = require('./util');
const version = require('../version');
const estimatedCapacityMixin = require('./estimated-capacity-mixin');
const statsMixin = require('./stats-mixin');

class SocketIoProxy extends statsMixin(estimatedCapacityMixin(EventEmitter)) {
  constructor(upstreamConfig, miners, proxyName) {
    super();
    this.fullUpstreamName = `${proxyName}/${upstreamConfig.name}`;
    this.fullUpstreamNameLogs = `${proxyName} | ${upstreamConfig.name}`;
    this.isBHD = upstreamConfig.isBHD || upstreamConfig.name.toLowerCase().indexOf('bhd') !== -1;
    this.upstreamConfig = upstreamConfig;
    this.historicalRoundsToKeep = upstreamConfig.historicalRoundsToKeep ? upstreamConfig.historicalRoundsToKeep : 720;
    this.userAgent = `BHD-Burst-Proxy ${version}/${hostname()}`;
    this.miningInfo = {height: 0};
    this.deadlines = {};
    this.miners = miners;
    this.roundStart = new Date();
  }

  async init() {
    await super.init();

    this.clients = {};

    const urlMappings = this.getUpstreamUrlMappings();
    let doHandlerSetup = true;
    for (let urlMapping of urlMappings.values()) {
      await this.setupMinersForUrl(urlMapping, doHandlerSetup);
      doHandlerSetup = false;
    }
  }

  async setupMinersForUrl(urlMapping, doHandlerSetup) {
    const client = io(urlMapping.url);

    if (urlMapping.accountIds.length > 0) {
      urlMapping.accountIds.forEach(accountId => this.clients[accountId] = client);
    } else {
      this.client = client;
    }

    client.on('connect', () => eventBus.publish('log/debug', `${this.fullUpstreamNameLogs} | url=${urlMapping.url} | websocket opened`));
    client.on('disconnect', () => eventBus.publish('log/debug', `${this.fullUpstreamNameLogs} | url=${urlMapping.url} | websocket closed`));

    if (!doHandlerSetup) {
      return;
    }

    client.on('miningInfo', this.onNewRound.bind(this));
  }

  async onNewRound(para) {
    if (this.upstreamConfig.sendTargetDL) {
      para.targetDeadline = this.upstreamConfig.sendTargetDL;
    }
    const miningInfo = new MiningInfo(para.height, para.baseTarget, para.generationSignature, para.targetDeadline);

    // save some stats for later
    const isFork = miningInfo.height === this.miningInfo.height && miningInfo.baseTarget !== this.miningInfo.baseTarget;
    const lastBlockHeight = this.miningInfo.height;
    const lastBaseTarget = this.miningInfo.baseTarget;
    const lastNetDiff = this.miningInfo.netDiff;
    const bestDL = this.getBestDL();
    const bestDLSubmitted = bestDL ? (bestDL.isLessThanOrEqualTo(this.upstreamConfig.targetDL)) ? bestDL : null : null;
    const accountIds = Object.keys(this.deadlines);

    this.roundStart = new Date();
    this.miningInfo = miningInfo;
    this.emit('new-round', miningInfo);
    this.deadlines = {};
    eventBus.publish('stats/current-round', this.fullUpstreamName, this.getCurrentRoundStats());
    let newBlockLine = `${this.fullUpstreamNameLogs} | New block ${miningInfo.height}, baseTarget ${miningInfo.baseTarget}, netDiff ${miningInfo.netDiff.toFixed(0)} TB`;
    if (miningInfo.targetDeadline) {
      newBlockLine += `, targetDeadline: ${miningInfo.targetDeadline}`;
    }
    eventBus.publish('log/info', newBlockLine);

    if (isFork) {
      return;
    }

    if (lastBlockHeight !== 0) {
      // Add historical, but wait some time till the wallet has caught up
      await new Promise(resolve => setTimeout(resolve, 7 * 1000));
      const lastBlockWinner = await this.getBlockWinnerAccountId(lastBlockHeight);
      const roundWon = accountIds.some(accountId => accountId === lastBlockWinner);

      await database().round.create({
        upstream: this.fullUpstreamName,
        blockHeight: lastBlockHeight,
        baseTarget: lastBaseTarget,
        netDiff: lastNetDiff,
        bestDL: bestDL ? bestDL.toString() : null,
        bestDLSubmitted: bestDLSubmitted ? bestDLSubmitted.toString() : null,
        roundWon,
      });
    }

    // Remove old historical
    const toDestroy = await database().round.findAll({
      where: {
        upstream: this.fullUpstreamName,
      },
      order: [
        ['blockHeight', 'DESC'],
      ],
      offset: this.historicalRoundsToKeep,
    });
    await Promise.all(toDestroy.map(row => row.destroy()));

    eventBus.publish('stats/historical', this.fullUpstreamName, await this.getHistoricalStats());
  }

  async submitNonce(submission, minerSoftware) {
    const client = this.getClientForAccountId(submission.accountId);
    if (!client) {
      eventBus.publish('log/error', `${this.fullUpstreamNameLogs} | Error: no client configured for accountId ${submission.accountId}`);
      return {};
    }

    const result = await new Promise(resolve => client.emit('submitNonce', submission.toObject(), {
      minerName: this.upstreamConfig.minerName || hostname(),
      userAgent: minerSoftware ? minerSoftware : this.userAgent,
      capacity: this.totalCapacity,
    }, resolve));

    return {
      error: null,
      result,
    };
  }

  getClientForAccountId(accountId) {
    if (!accountId) {
      return this.client;
    }

    if (this.clients[accountId]) {
      return this.clients[accountId];
    }

    return this.client;
  }

  getUpstreamUrlMappings() {
    const urlMappings = new Map();
    if (this.upstreamConfig.urlForAccountId) {
      Object.keys(this.upstreamConfig.urlForAccountId).forEach(accountId => {
        const url = this.upstreamConfig.urlForAccountId[accountId];
        let urlMapping = {
          accountIds: [],
          url,
        };
        if (urlMappings.get(url)) {
          urlMapping = urlMappings.get(url);
        }
        urlMapping.accountIds.push(accountId);

        urlMappings.set(url, urlMapping);
      });
    }
    if (this.upstreamConfig.url && !this.upstreamConfig.allAccountIdsConfigured) {
      const url = this.upstreamConfig.url;
      let urlMapping = {
        accountIds: [],
        url,
      };
      if (urlMappings.get(url)) {
        urlMapping = urlMappings.get(url);
      }

      urlMappings.set(url, urlMapping);
    }

    return urlMappings;
  }

  async getBlockWinnerAccountId(height) {
    if (!this.upstreamConfig.walletUrl) {
      return -1;
    }

    return util.getBlockWinnerAccountId(this.upstreamConfig.walletUrl, true, height);
  }

  getMiningInfo() {
    return this.miningInfo.toObject();
  }

  recalculateTotalCapacity() {
    super.recalculateTotalCapacity();
    if (this.client) {
      this.client.capacity = this.totalCapacity;
    }
  }
}

module.exports = SocketIoProxy;