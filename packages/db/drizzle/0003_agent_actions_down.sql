-- Down migration for 0003_agent_actions.
-- Drops only what 0003 created; helper functions and the app role are
-- cluster-level objects owned by 0002 and stay put.
DROP TABLE IF EXISTS payment_promises;
DROP TABLE IF EXISTS action_proposals;
