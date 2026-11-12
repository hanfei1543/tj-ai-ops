# TJ PO 分阶段上线：迁移、备份与回滚

## 当前适用范围
本轮只在 feature/combined-po 修正并验收。不得 merge/push main、部署正式网站、写入真实 Windows Queue 或过账 IRS。最新授权与三项解除条件见 docs/handoffs/combined-po-prelaunch.md。
历史 public 的 combined 字段迁移已经存在，不代表本轮日期／护栏迁移已在生产应用。本轮生产迁移必须另行授权。

## 迁移原则
- 日期用 nullable date，无默认值，不回填创建／收货／审批时间。
- 新流程缺日期不得提交审批／批准；批准后日期及商品明细冻结。
- 旧冻结 Preview PO-000003 保留原状，不能为补日期而直接重写。
- Combined PO、合并来源单 Push，GR 正式 Push／过账，Add New Item 分别维持停用；网站上线或回滚都不自动解除。
- 推送器显式 public；Preview 显式 tj_preview；独立 identity、外键、数据。service_role 当前没有 tj_preview schema 使用权限，但权限将来可能变化，因此不单靠 403，仍需前台/API/推送器/数据库护栏。
- 不以服务端报成功代替读回验证；迁移、回归与样本产出分别记录。

## 备份
已生成变更前 TJ PO 逻辑备份：
/home/hermes/backups/TJ-AI-Ops/20261112T065718Z/tj-prelaunch-backup.json

权限 0600；SHA-256 由工具记录为 1bddf9d74ffceb3c1188dc6c90fbc2171ea28538eb4d80d3003de5216ac9142e。
范围为 public 与 tj_preview 的 tj_po_headers、tj_po_lines、tj_po_exports、tj_item_requests，以及序列状态、约束、触发器定义。商业数据不入 Git。此备份不是全库一致性 pg_dump，不含商品／供应商主数据，也不是异机灾备。

正式迁移前需再次备份并核对期间是否有新订单，不能把本快照覆盖期间真实业务。若使用 pg_dump，必须使用 Dashboard Connect 提供的 PostgreSQL 连接串；SUPABASE_URL 是 HTTP API URL，不能当作数据库连接串。

## PO 序号保护
变更前实查：public last_value=12/is_called=false；tj_preview last_value=5/is_called=true。
测试不要消费或重置生产序列。优先在 Preview 事务里使用显式测试序号并回滚；identity/sequence 通常不随事务回滚，所以不能简单以“回滚了测试”断言序号未变，测试前后必须查实值。
禁止运行旧文档中的通用 max(po_seq)+1 重置方案；已有并发、预留序号与审计要求时会造成冲突。任何正式序号调整必须单独授权。

## 安全回滚顺序
1. 核对真实部署 commit、schema、是否有新增订单与待推送任务；先保全当前数据，不覆盖原冻结快照。
2. 网站可回退到经过授权的稳定构建，但必须保留 Combined／来源 Push 禁止、GR 过账禁止、Add New Item 停用。旧网页可能没有这些限制，数据库和后台护栏不能随网页一起撤掉。
3. 推送器保留本轮安全护栏；不可简单恢复到原来不识别 Combined 的脚本。若护栏有缺陷，在原普通单路径上修复，不以解除冻结作回滚。
4. 日期、验证证据、来源关系与已冻结数据保留；默认不 DROP COLUMN、不 DROP 表、不 DROP schema，不重置 identity。
5. 真需撤销某个新触发器或恢复业务数据，先制定最小恢复清单，由用户确认，验证恢复后仍拒绝三项冻结功能，再操作。

## 隔离测试库回滚
只有 Preview 结构且没有需保留新业务时，可在备份与批准后撤销本轮特定对象。不要直接 DROP SCHEMA tj_preview CASCADE：它会删除测试证据，且并非无损操作。不能通过移除 PostgREST schema 或篡改 production env 来“临时修复”隔离。

## 正式上线前必查
- Preview 新日期流程与冻结防篡改、合并分组／顺序／实收数量、来源追溯通过。
- 普通单 CRUD 与原 7 列、public 推送器 mock Queue/Bridge 路径通过；不以真实入队作本轮测试。
- 明确区分本地构建、托管 Preview、生产当前版本，不能把本地通过说成线上已部署。
- 新 commit、独立审查、Preview 迁移与读回、Excel 逐行读回证据齐全。
- 用户单独授权生产迁移、main merge/push、正式部署；三项冻结解除仍须各自授权。
