# Agent Note: Trusted authorities use the complete API

Status: implemented

## Problem

The browser carrier already admitted an explicitly declared non-loopback authority to session creation, prompts, and the shipped agent's shell and filesystem tools, but a second method list rejected preset authoring, plugin settings, credentials, model discovery, and native path actions with HTTP 403. A remote Harness page could run an agent while its ordinary management screens were empty or broken. The split did not form an authorization boundary because the admitted session surface could exercise equivalent process authority.

## Decision

The `/api` carrier makes one trust decision for every method. Loopback authorities and exact `trustedHosts` entries reach the complete API; undeclared hosts, cross-origin browser requests, explicit cross-site requests, and non-JSON POSTs remain rejected before dispatch. Deployment binding, reverse-proxy network policy, and TLS continue to determine who can reach a trusted authority.

`trustedHosts` remains a DNS-rebinding and same-origin fence, not user authentication. A deployment that exposes Harness to a network accepts that network's callers for preset, settings, credential, model-discovery, native-path, and session operations together. Native path operations still act on the Harness host and can report an unavailable desktop on a headless machine.

## Alternatives considered

**Keep the loopback-only method list.** Rejected because it leaves the supported remote Web application internally inconsistent while session execution already admits equivalent authority.

**Add another deployment switch for the listed methods.** Rejected because it preserves two authorization classes without an authentication identity to distinguish them and adds configuration for an incoherent boundary.

**Add login and account authorization first.** Deferred because authentication is a separate product capability. The carrier still documents its unauthenticated trusted-network assumption instead of presenting the removed method list as protection.

## Consequences

Trusted non-loopback pages can duplicate and inspect agent presets, render plugin and model settings, manage credentials, discover models, and invoke host path actions. Operators must restrict the serving authority with binding or reverse-proxy network policy when the surrounding network is not trusted. Focused carrier tests exercise every formerly split method through both the in-memory bridge and a real HTTP server.
