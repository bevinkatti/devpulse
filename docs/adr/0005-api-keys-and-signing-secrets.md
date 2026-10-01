# ADR 0005: API key hashing and encrypted signing secrets

Status: accepted

High-entropy API keys are SHA-256 hashed because the random key has enough entropy to resist offline guessing; only a prefix is indexed for lookup. Webhook signing secrets must be recovered by the worker, so they are encrypted at rest using AES-256-GCM and a deployment-provided 32-byte key. API key and signing secret values are shown only when created or rotated. Key rewrapping is an operational migration that must precede encryption-key rotation.
