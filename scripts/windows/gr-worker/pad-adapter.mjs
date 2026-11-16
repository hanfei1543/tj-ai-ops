// PAD（Power Automate Desktop）适配器 —— 明确的 Worker 接口，当前「待接入」。
//
// 两个接口对应两件必须由真实 IRS/PAD 完成的事，绝不能伪造：
//   1. saveEntry(task) —— PAD 未保存录入：把 task.scope.lines 录入 IRS Goods Receive 界面。
//      返回 PAD 录入的原始结果（是否成功、是否有界面错误）。失败抛错。
//   2. readBack(task)   —— 保存后独立回查：真实读回 IRS 单据，核对 GRN/行/数量/单价，
//      返回 task_result 的 evidence（含 irs_grn_no / saved_at / lines 逐行证据）。
//
// 当前两者都未接入（PAD flow 尚未连接真实 IRS 保存），因此 isConnected() 返回 false，
// worker 不会领取任务（避免 claim 后无法保存造成 needs_review 污染）。
// 接入时：实现 saveEntry / readBack，把 isConnected() 改为返回 true，并据真实 IRS 返回填 evidence。
//
// 安全要求（接入时必守）：
//   * saveEntry 必须真实驱动 PAD 完成录入；不能返回假的成功。
//   * readBack 必须真实读回 IRS 单据并逐行核对；没有真实 GRN 回查证据 → 不得返回 verified evidence。
//   * 保存结果不明（超时/断线）→ 抛错，由 worker 回报 needs_review，绝不重发重复过账。

export function createPadAdapter(config = {}) {
  const connected = config.connected === true

  function isConnected() {
    return connected
  }

  async function saveEntry(task) {
    throw new Error('PAD_NOT_CONNECTED: PAD 未保存录入接口待接入（saveEntry 未实现）')
  }

  async function readBack(task) {
    throw new Error('PAD_NOT_CONNECTED: 保存后独立回查接口待接入（readBack 未实现）')
  }

  return { isConnected, saveEntry, readBack }
}
