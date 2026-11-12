// 功能开关（上线前冻结口径，改这里就等于改业务边界，需独立授权）
//
// Add New Item：IRS Item Master 字段未验收，功能暂停。
//   * 界面不显示入口，旧隐藏快捷键（Ctrl+Alt+I）已移除；直链进入只看到停用说明。
//   * 所有写 API（新建/批准/拒绝/回写）一律拒绝，避免产生半成品数据。
// GR：只允许内部 Excel 导出，正式 push/post 到 IRS 不启用。
// 合并单推送：永久冻结（见 lib/core/push-policy.js，与后端推送器同源规则）。

/** Add New Item 写操作总开关：false = API 直接拒绝写 */
export const ADD_ITEM_WRITES_ENABLED = false

/** GR 正式 push/post 开关：false = 永不启用，只出内部 Excel */
export const GR_PUSH_POST_ENABLED = false
