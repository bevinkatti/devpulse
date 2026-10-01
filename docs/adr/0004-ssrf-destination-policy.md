# ADR 0004: Webhook destination controls

Status: accepted

The API validates destination syntax and policy when an endpoint is created or changed. The worker repeats DNS resolution and address validation immediately before sending, pins one approved address through the HTTP client's lookup callback, rejects URL credentials/fragments and unsafe schemes, and disables redirects. Production requires HTTPS and globally routable resolved addresses. A development-only explicit flag can permit local/private receivers for controlled tests. Network-level egress restrictions are still required to handle routes and infrastructure beyond application visibility.
