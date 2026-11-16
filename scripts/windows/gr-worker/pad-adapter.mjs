// PAD（Power Automate Desktop）适配器 —— 明确的 Worker 接口，当前「待接入」。
//
// 四个接口对应四件必须由真实 IRS/PAD 完成的事，绝不能伪造：
//   1. isReady()              真实接口就绪检查：saveEntry/commitSave/readBack 都已实现且可连通。
//                             注意：TJ_GR_PAD_CONNECTED=true 只表示「已配置连接」，不等于「真实接口就绪」。
//                             只要三者仍抛 PAD_NOT_CONNECTED，isReady() 就必须返回 false（worker 不领取）。
//   2. saveEntry(task)        未保存录入：把 task.scope.lines 录入 IRS Goods Receive 界面，但不提交（草稿）。
//                             返回 draft handle（含录入的逐行镜像 lines），供 commitSave 提交。
//   3. commitSave(task,draft) 实际 Save 一次：提交草稿。只能调用一次（重复提交 = 重复过账）。
//                             明确成功返回 {saved:true, irs_grn_no?, saved_at?}；
//                             明确失败返回 {saved:false, error}；
//                             超时/断线/结果不明 → 抛错（由 worker 转 needs_review，绝不重试）。
//   4. readBack(task)         保存后独立回查：真实读回 IRS 单据，逐行核对 GRN/数量/单价，
//                             返回 task_result 的 evidence（含 irs_grn_no / saved_at / lines 逐行证据）。
//
// 当前四个接口都未接入（PAD flow 尚未连接真实 IRS 保存），isReady() 返回 false，worker 不领取任务
// （避免 claim 后无法保存造成 needs_review 污染）。
// 接入时：实现 saveEntry/commitSave/readBack，isReady() 返回 true，并据真实 IRS 返回填 evidence。

export function createPadAdapter(config = {}) {
  // config.connected 只反映环境开关 TJ_GR_PAD_CONNECTED；真实就绪由 isReady() 决定。
  const connected = config.connected === true

  function isConnected() {
    return connected
  }

  function isReady() {
    // 真实接口就绪检查：三个接口都未实现（占位抛错）→ false。
    // 接入时改为返回 true（saveEntry/commitSave/readBack 已实现并连通）。
    return false
  }

  async function saveEntry(task) {
    throw new Error('PAD_NOT_CONNECTED: 未保存录入接口待接入（saveEntry 未实现）')
  }

  async function commitSave(task, draft) {
    throw new Error('PAD_NOT_CONNECTED: 实际保存接口待接入（commitSave 未实现）')
  }

  async function readBack(task) {
    throw new Error('PAD_NOT_CONNECTED: 保存后独立回查接口待接入（readBack 未实现）')
  }

  return { isConnected, isReady, saveEntry, commitSave, readBack }
}
