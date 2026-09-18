SELECT id, version, created_at, cwd, parent_session, seed_length, origin,
       delegation_depth, agent_preset, session_policy, incarnation, revision
FROM sessions
WHERE id = ?;
