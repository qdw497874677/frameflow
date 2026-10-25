# Marks transaction log (F03)

## Internal interfaces

`MarksStore.apply(items, lookup)` remains the existing API: per-item results, unknown/invalid items isolated, duplicate photo IDs staged in order, server-generated random operation IDs. Star clamping and delete-wins semantics are unchanged. A batch publishes memory only after its single envelope has been fully written and fsynced. Every valid item advances its photo revision, including same-value writes; history contains actual field changes only.

`MarksStore.transact({ opId, items, expectedRevisions?, confirmation? }, lookup)` is **internal**, not a new HTTP API. `expectedRevisions` maps photo IDs to their pre-batch revision; repeated IDs then increment sequentially. `confirmation` is optional JSON object metadata only: it does not update jobs or authorize anything. Requests must be lossless JSON (no undefined, NaN, functions, cyclic values or sparse arrays at any nesting depth). Invalid JSON-shaped mark items get individual failures. The result is `{ opId, results, revisions }`, with final revisions for valid items.

Stable IDs are checked before revision checks and target lookup. Same ID plus the same canonical request SHA-256 returns the original durable result without republishing state, looking up targets, or writing XMP. Same ID with different payload throws `OP_ID_REUSED`; stale revisions throw `REVISION_CONFLICT`. Object key order does not affect hashing; array order, omitted fields versus explicit defaults, metadata and expected revisions do. Callers must preserve the original request. Failures before commit are not indexed. The index and returned values are separated by copies.

`revisionOf(photoId)` starts at zero for absent/XMP-only state. Each legacy MarkChange row for that photo adds one; each valid new item adds one. This deterministic baseline is not a source generation. `get()` and `list()` return copies. History remains flattened MarkChange records, newest first, with existing photo/job filters and no envelope leakage.

Stable-op results describe the durable marks commit, not best-effort sidecar delivery. XMP failure in `transact` emits `MARKS_XMP_WRITE_FAILED` with the opId; it does not change the persisted result. The old `apply` API retains its per-item XMP warning. Neither path automatically retries XMP during replay.

## Format and recovery

The mixed `marks.jsonl` format deliberately does **not** use F02's strict connector Journal reader. Legacy unversioned MarkChange rows remain readable. New rows contain `version: 1`, `kind: "mark-transaction"`, `opId`, canonical `requestHash`, ordered `entries`, optional confirmation, a durable result, and a checksum over the canonical envelope body. Each entry has photo ID, expected/new revisions, complete `stars/del/by/channel/at` state, and flattened changes. Full state preserves XMP-seeded fields even when only another field changes, and preserves same-value attribution.

Complete rows must round-trip their original UTF-8 bytes without replacement decoding (literal U+FFFD remains valid). Complete rows are parsed explicitly: invalid UTF-8, invalid JSON, invalid schema, checksum mismatch, unknown version, blank complete rows, duplicate operations and broken revision chains fail closed. Checksums detect accidental damage, not malicious tampering. No complete corrupt row is skipped. Legacy rows lack checksums and retain their original limitations.

An unterminated tail (even parseable JSON without its newline) is not a commit. Default open refuses it with `MARKS_TRUNCATED_TAIL`. An operator can back up the log and explicitly reopen `new MarksStore(dataDir, { repairTail: true })`; inspect `.repair` for `TRUNCATED_TAIL_REPAIRED`, byte offset and removed-byte count. Only the unterminated suffix is truncated; complete rows, including duplicate operation IDs and revision continuity across legacy and new entries, are validated first. Any complete-row corruption leaves the entire file byte-for-byte unchanged, including an accompanying partial suffix. Production (`Library`) opens with `repairTail: true`: on startup an unterminated tail is truncated and the server logs a warning with offset and removed bytes. Complete-row corruption still refuses to start; the server prints the data-check findings and suggests `npm run repair`, which backs up each affected jsonl file to `<file>.corrupt-<time>.bak` and drops lines that are not valid JSON (note: dropping a versioned envelope can still break the revision chain — restore from backup in that case). Recovery fsyncs the valid log and its directory before making any recovered operation available.

Append loops until the entire UTF-8 row and newline are written, fsyncs the file, and fsyncs its containing directory (including creation). Open failure before the first write permits retry on that instance, including the existing directory-at-log-path regression. Once write has been attempted, any write/flush uncertainty throws `MARKS_COMMIT_UNKNOWN` and poisons the instance; subsequent transactions throw `MARKS_POISONED`. Memory/history/revisions and XMP are not published on that failure. **Unknown does not mean absent**: a complete row can survive an error. Reopen, repair an incomplete tail explicitly if necessary, fsync, and reconcile the original stable opId. Do not blindly generate a replacement ID. The legacy API preserves its error response shape but includes the unknown/poisoned diagnostic.

## Scope and limits

- F03 assumes one local-filesystem writer. F02's writer guard is standalone/reviewed and is **not installed in this runtime**. Two stores/processes writing one directory are unsupported. This work does not claim multiprocess safety.
- F04 source generations are not implemented. Existing photo-ID-based replay can apply historical state to a replaced source. No automatic stale-XMP recovery/writeback has been added.
- F05 photo/job gates and cross-call XMP ordering are not implemented. Separate operations can still race their asynchronous sidecar writes. Stable-op replay itself never rewrites an old sidecar.
- Whole-log replay and operation retention are unbounded, as with existing history; compaction/retention is future work. Synchronous fsync adds latency. This is local process-crash/I/O-injection durability, not an arbitrary hardware, filesystem, or network-share loss guarantee.
- No downgrade in place: old binaries silently ignore envelopes and would lose committed state/attribution. Back up before rollout; rollback requires an offline, reviewed export/migration. Flattening changes alone loses same-value confirmations, full seeded state, revisions and deduplication facts. Do not run mixed-version writers.

## Verification evidence

Focused TDD initially failed all five tests because `transact`/`revisionOf` did not exist; implementation made them green. Expanded coverage after review: 13/13 transaction tests, 3/3 existing durability tests, and server typecheck pass. Fault cases include partial and short writes, write-then-throw, file fsync, directory fsync, recovery fsync, corruption, explicit tail repair, stale requests, no-op versions, mixed logs and actual-sidecar replay after newer values. The old no-op unchanged-log assertion was deliberately replaced by the versioned-envelope contract; its failure and history assertions remain.

Isolated jobs e2e passed 81/81. Original annotate e2e passed 93/94: its one failure assumes top-level legacy `by/jobId` in raw disk rows, incompatible with the approved envelope format. The repository script is outside the five-file ownership scope and was not edited. An isolated temporary copy changed only that assertion's input to flatten envelope `entries[].changes`, preserving the assertion itself: 94/94 passed. All other behavior checks ran unchanged. Temporary copies also redirected fixed /tmp paths and used ephemeral ports so existing fixtures/dev service were untouched.

Evidence: `/tmp/f03-isolated-e2e-q9chjats` (original assertion result), `/tmp/f03-envelope-e2e-art_9vaz` (final jobs and envelope-aware annotate output). The owning agent subsequently registered and completed F03a in `tasks/todo.md`: repository `server/tools/e2e-annotate.mjs` now flattens legacy/new rows for that same persisted by/jobId assertion, without removing it.

Review regression RED → GREEN: the two recursive sparse-array cases initially committed instead of rejecting; duplicate-operation and rechecksummed revision-chain cases initially truncated the partial suffix before throwing; malformed multibyte UTF-8 initially decoded to the checksummed U+FFFD and opened successfully. All five reproductions now pass. Rejections preserve log bytes, memory/history and revisions; defensive-copy coverage mutates `get`, `list`, initial transaction results and replay results, both live and after reopen. Verification commands: `node --test server/tools/marks-transaction.test.mjs server/tools/e2e-marks-durability.mjs` (16/16), and `cd server && npm run typecheck` (pass). No service restarts or public API changes.

## F31：连接器故障注入与备份/恢复演练

自动化演练：`(cd server && node --test tools/connector-recovery.test.mjs)`，夹具 `server/tools/connector-fixture.mjs`
在 `os.tmpdir()` 下建临时照片库与 dataDir，进程内起真实 `buildServer`，飞书 SDK 为可编排假实现（不触网、零真实发送）。
覆盖的中断点与结论：

| 中断点 | 恢复后行为 |
| --- | --- |
| 发送意图已落账、平台未回即崩溃 | 重启收敛为 `unknown`（`RESTART_WHILE_SENDING`），不自动重发；重试必须显式接受 `DUPLICATE_RISK`，重发沿用幂等 uuid |
| SDK 超过传输超时后迟到成功 | 记 `unknown` 而非 `failed`，重启后仍为 `unknown`，不自动重发 |
| 平台成功、messageId 行写到一半（尾部无换行） | 半行视为未发生 → `unknown`，不重发 |
| 投递账本中间完整行损坏 | 账本只读：不收敛写入、不建分片、不调用 SDK；文件字节保持原样，等待人工处理 |
| 确认记录完整行损坏 | 确认/追加/恢复返回 `503 STORE_CORRUPT`；仅尾部半行仍按"未发生"容忍 |
| 重启后停用实例 / 已送达目标 | 停用后重试零外传；`sent` 为终态，重试返回 `NOTHING_TO_RETRY` |
| 长连接在恢复完成前推送事件 | 服务在 `feishu.recover()` 完成后才开接收，之前的事件返回 `RECOVERING`，不落动作日志、不回写卡片 |

### 备份/恢复步骤（仅临时 dataDir 演练过）

1. 停服务（确保没有进程持有 `deliveries.jsonl` / `delivery-confirmations.jsonl` / `feishu/`）。
2. 整目录复制 dataDir（`cp -a`）；不要只复制部分文件——确认记录与投递账本必须同一时刻。
3. 恢复时整目录替换后再启动。恢复点之后的投递记录消失，但**不会被自动补发**；平台上若已有恢复点之后发出的消息，它们不会被识别，需人工判断后再派发。
4. 任务与标记存放在照片库侧（marks/jobs），恢复 dataDir 不会回滚它们；二者时间点不一致时，以照片库侧为准，连接器侧只影响"是否已投递"的展示与重试。

### 旧格式降级限制

- 连接器数据全部位于新增文件（`connectors.json`、`deliveries.jsonl`、`delivery-confirmations.jsonl`、`feishu/`），旧版本会忽略它们，可直接降级运行；降级期间网页标记照常写 marks.log。
- 降级后再升级：降级期间产生的标记会被飞书进度正常读取；但降级期间没有投递对账，任何处于 `sending/unknown` 的分片升级后仍保持 `unknown`，需人工确认后重试。
- 不提供把连接器账本转换回旧格式的工具，也不做破坏性迁移；损坏文件需人工修复（删除损坏行前先备份）。
