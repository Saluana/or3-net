# 4. OR3 Intern

## Repo Role

`or3-intern` remains the execution dependency behind `or3-net`.

It is still in scope because OR3 Net already relies on:

- durable session binding
- stream normalization
- abort behavior

But unlike the old provider-specific auth work, this repo is still on the real critical path.

## Production Objective

Verify that intern behavior cleanly supports:

- `network_session_id` binding
- stable event ordering
- replay/reconnect expectations
- deterministic abort semantics

## Deliverables

- [ ] verify durable session mapping from OR3 Net down to intern execution
- [ ] verify stream event ordering needed by OR3 Net job/session history
- [ ] verify abort semantics are deterministic enough for UI consumption
- [ ] patch only the missing contract points

## Definition Of Done

This repo is done only when:

- OR3 Net can expose stable chat-facing sessions and streams on top of intern execution
- no lossy or guessed normalization remains in the critical path

## References

- `../README.md`
- `../../../src/session/service.ts`
- `../../../src/execution/local-jobs.ts`
