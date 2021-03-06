const cache = require('./cache');
const database = require('../../models');
const eventBus = require('./event-bus');

class RoundPopulator {
    async populateRound(upstream, height) {
        eventBus.publish('log/debug', `Round-Populator | ${upstream.fullUpstreamNameLogs} | Populating round ${height}`);
        const blockInfo = await upstream.getBlockInfo(height);
        if (!blockInfo || !blockInfo.hash || !blockInfo.plotterId) {
            return;
        }
        const round = await cache.ensureRoundIsCached(upstream, height);
        round.blockHash = blockInfo.hash;
        const activePlotter = await upstream.getActivePlotter(round.blockHeight);
        round.roundWon = activePlotter.some(plotter => plotter.pid === blockInfo.plotterId);

        await cache.saveEntity(round);
    }

    async populateUnpopulatedRounds(upstream, maxHeight) {
        const unpopulatedRounds = await database().round.findAll({
            where: {
                upstream: upstream.fullUpstreamName,
                [database().Op.or]: [{
                    roundWon: null,
                }, {
                    blockHash: null,
                }],
                blockHeight: {
                    [database().Op.lt]: maxHeight,
                },
            },
            order: [
                ['blockHeight', 'ASC'],
            ],
        });
        for (let round of unpopulatedRounds) {
            await this.populateRound(upstream, round.blockHeight);
        }
    }
}

module.exports = new RoundPopulator();
