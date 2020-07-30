const Capacity = require('../shared/capacity');
const coinUtil = require('./coin-util');

module.exports = class MiningInfo {
  constructor(height, baseTarget, generationSignature, targetDeadline = null, coin = null) {
    this._height = parseInt(height, 10);
    this._baseTarget = parseInt(baseTarget, 10);
    this._generationSignature = generationSignature;
    this._targetDeadline = targetDeadline;
    this._coin = coin;
  }

  get blockZeroBaseTarget() {
    return coinUtil.blockZeroBaseTarget(this._coin);
  }

  get height() {
    return this._height;
  }

  get baseTarget() {
    return this._baseTarget;
  }

  get generationSignature() {
    return this._generationSignature;
  }

  get targetDeadline() {
    return this._targetDeadline;
  }

  get netDiff() {
    return Math.round(this.blockZeroBaseTarget / this.baseTarget);
  }

  get modifiedNetDiff() {
    return coinUtil.modifyNetDiff(this.netDiff, this._coin);
  }

  get modifiedNetDiffFormatted() {
    return Capacity.fromTiB(this.netDiff).toString();
  }

  toObject() {
    const obj = {
      height: this.height,
      baseTarget: this.baseTarget,
      generationSignature: this.generationSignature,
    };
    if (this.targetDeadline) {
      obj.targetDeadline = this.targetDeadline;
    }

    return obj;
  }
};
