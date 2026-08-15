# Security issue: weak account and session controls

## Summary

rss.voice currently treats control of an email address as the only proof of account ownership. This is insufficient protection against trolls, disposable-email abuse, impersonation, or false claims.

## Current behavior

- No password or second authentication factor.
- Authentication uses an email magic-link code.
- The frontend stores `email`, `code`, and `screenname` indefinitely in `localStorage`.
- The server does not expire sessions.
- Requesting another magic link rotates the stored code and invalidates the previous one.
- There is no account-deletion route.
- Screenname uniqueness prevents taking an already-claimed name, but does not prevent lookalike names.
- Basic write rate limits and media limits are the main abuse controls.

## Risks

- Anyone with access to the browser's local storage can authenticate as the user until the code is rotated.
- Disposable-email users can create throwaway accounts and post or upload media.
- Attackers can claim unclaimed names or create confusing lookalikes.
- Users cannot remove their account or posts through an account-deletion flow.
- A claimed rss.voice identity is not independently verified beyond email control.

## Recommended minimum fixes

1. Replace the long-lived URL code with a server-issued, expiring session token.
2. Store the session in an `HttpOnly`, `Secure`, `SameSite` cookie rather than `localStorage`.
3. Add logout and server-side session revocation.
4. Add account and content deletion workflows.
5. Add abuse controls such as CAPTCHA, disposable-email filtering, and stronger rate limits.
6. Add reserved-name and lookalike-name handling.

These controls should be addressed before exposing managed multi-tenant hosting to the public. Email magic links can remain the login mechanism; they should not also be the permanent session credential.
