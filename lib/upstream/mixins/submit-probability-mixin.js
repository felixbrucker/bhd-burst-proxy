const moment = require('moment');
const eventBus = require('../../services/event-bus');
const coinUtil = require('../../coin-util');

module.exports = (upstreamClass) => class SubmitProbabilityMixin extends upstreamClass {
  async init() {
    this.useSubmitProbability = !!this.upstreamConfig.submitProbability;
    this.targetDLFactor = null;
    if (this.useSubmitProbability) {
      let submitProbability = this.upstreamConfig.submitProbability > 10 ? this.upstreamConfig.submitProbability / 100 : this.upstreamConfig.submitProbability;
      if (submitProbability >= 1) {
        submitProbability = 0.999999;
      }
      this.targetDLFactor = -1 * Math.log(1 - submitProbability) * (this.blockTime);
    }
    if (super.init) {
      await super.init();
    }
  }

  updateDynamicTargetDL(miningInfo) {
    const totalCapacityInTiB = this.getTotalCapacity() / 1024;
    if (totalCapacityInTiB === 0) {
      this.dynamicTargetDeadline = null;
      return;
    }
    this.dynamicTargetDeadline = Math.round(this.targetDLFactor * miningInfo.netDiff / totalCapacityInTiB);
    eventBus.publish('log/debug', `${this.fullUpstreamNameLogs} | Submit Probability | Using targetDL ${this.getFormattedDeadline(this.dynamicTargetDeadline)}`);
  }

  getFormattedDeadline(deadline) {
    if (!this.proxyConfig.humanizeDeadlines) {
      return deadline;
    }

    const duration = moment.duration(deadline, 'seconds');
    if (duration.years() > 0) {
      return `${duration.years()}y ${duration.months()}m ${duration.days()}d ${duration.hours().toString().padStart(2, '0')}:${duration.minutes().toString().padStart(2, '0')}:${duration.seconds().toString().padStart(2, '0')}`;
    } else if (duration.months() > 0) {
      return `${duration.months()}m ${duration.days()}d ${duration.hours().toString().padStart(2, '0')}:${duration.minutes().toString().padStart(2, '0')}:${duration.seconds().toString().padStart(2, '0')}`;
    } else if (duration.days() > 0) {
      return `${duration.days()}d ${duration.hours().toString().padStart(2, '0')}:${duration.minutes().toString().padStart(2, '0')}:${duration.seconds().toString().padStart(2, '0')}`;
    }

    return `${duration.hours().toString().padStart(2, '0')}:${duration.minutes().toString().padStart(2, '0')}:${duration.seconds().toString().padStart(2, '0')}`;
  }

  get blockTime() {
    return coinUtil.blockTime(this.upstreamConfig.coin);
  }
};