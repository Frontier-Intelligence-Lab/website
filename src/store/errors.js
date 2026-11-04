// Thrown by every store implementation for expected conflicts; routes map `code` to a 4xx response.
export class StoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export const STORE_ERRORS = ['email_taken', 'slug_taken', 'personal_exists', 'not_found', 'already_decided', 'already_member', 'invite_expired', 'duplicate_upload', 'invalid_state', 'quota_exceeded', 'forbidden', 'issues_open', 'label_in_use', 'invalid_label'];
