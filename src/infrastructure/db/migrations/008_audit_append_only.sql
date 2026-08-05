-- 审计与历史真的变成 append-only（FR-IAM-013）。
--
-- 001_foundation.sql 里 `audit_log` 上方写着一行注释：
-- 「append-only，永不物理删除」。而同一个文件末尾有一段循环，
-- 给**每一张表**都授了 SELECT, INSERT, UPDATE, DELETE，
-- 其中包括 audit_log 和 resource_history。
--
-- 也就是说：应用角色一直可以改写、删除审计记录，
-- 而那行注释让所有人以为不可以。
--
-- **应用能改写的审计日志不是审计日志。** 它的价值全部来自
-- "发生过的事一定还在里面"这一条，而这一条此前只是一句话。
--
-- 顺带满足「≥ 1 年保留」：连删除的权限都不给，比任何保留期都强。
-- 真要清理历史数据时，用管理员连接执行一次有记录的运维操作——
-- 那应当是一次有人签字的事，不是应用随手能做的事。

REVOKE UPDATE, DELETE ON audit_log FROM projectos_app;
REVOKE UPDATE, DELETE ON resource_history FROM projectos_app;

-- 光收回权限还不够：将来给某张表补授权时，很容易一句
-- `GRANT ALL ON ALL TABLES` 就把这里悄悄撤销掉。
-- 触发器是**表自己**带着的规则，跟着表走，不依赖谁记得。
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING HINT = 'audit and history are the record of what happened; correct them by appending, not by rewriting';
END;
$$ LANGUAGE plpgsql;

-- FOR EACH STATEMENT 而不是 FOR EACH ROW。
--
-- 行级触发器**一行都没匹配到时不会触发**，于是
-- `DELETE FROM audit_log WHERE ...` 在没命中的时候会安静地成功——
-- 看起来这条语句是被允许的。语句级的语义才是想要的那一条：
-- 这两张表上**不接受** UPDATE / DELETE 这个动作本身。
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER resource_history_append_only
  BEFORE UPDATE OR DELETE ON resource_history
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
