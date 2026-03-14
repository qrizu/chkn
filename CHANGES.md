# CHKN Changes

Updated: 2026-03-14

## Membership, friends, and paywall

- Added database support for registration-code memberships, user memberships, and friend relationships.
- Added API routes for membership lookup, registration-code redemption, friend search, friend requests, request responses, removal, and compatibility lookup.
- Locked AI-backed features behind active membership:
  - Madame Flood tarot/oracle replies
  - GTA 5 avatar generation
- Restricted profile and profile-insight access so users must be the owner or an accepted friend.

## Frontend

- Added a membership and friends section on the profile page.
- Added registration-code redemption UI.
- Added member search, incoming/outgoing request handling, accepted friends, and compatibility modal access.
- Expanded the compatibility reading into astrology-based areas such as identities, emotions, communication, love, responsibility, sex/aggression, philosophies of life, work points, and easy flow.
- Added clear paywall messaging for locked AI features in tarot and avatar flows.
- Added styling for the new membership and social UI blocks.

## Cleanup of dev-suffixed references

- Removed dev-suffixed host examples and compose service examples from the README.
- Removed the extra Vite allowed host entry for the dev-suffixed CHKN host.
- Changed frontend example/development Yatzy URLs to the primary host.
- Changed the default places user-agent to `chkn/1.0`.
- Removed the CHKN backend/frontend dev services and their dev-only volumes from the root docker compose file.

## Verification

- Frontend build completed successfully with `npm run build` in `apps/web`.
- Backend full TypeScript checking still has older unrelated errors in existing files outside this cleanup.
