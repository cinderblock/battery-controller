/**
 * Password-based settings lock.
 *
 * When locked, test start/stop/parameter changes are rejected.
 * Read-only monitoring (WebSocket readings, data queries) still works.
 * Lock state persists across Pi reboots (stored in SQLite settings table).
 *
 * Uses Bun's built-in Bun.password for bcrypt hashing — no external deps.
 */

import { getSetting, setSetting } from './db.ts';
import { logger } from '../utils/logger.ts';

const SETTING_PASSWORD_HASH = 'lock_password_hash';
const SETTING_LOCK_ENABLED = 'lock_enabled';

export class SettingsLock {
  private listeners = new Set<(locked: boolean) => void>();

  /** Whether a password has been configured */
  hasPassword(): boolean {
    return getSetting(SETTING_PASSWORD_HASH) !== null;
  }

  /** Whether the lock is currently engaged */
  isLocked(): boolean {
    return getSetting(SETTING_LOCK_ENABLED) === 'true';
  }

  /**
   * Set or change the lock password.
   * If a password already exists, oldPassword must match.
   * Returns true on success, false if oldPassword is wrong.
   */
  async setPassword(newPassword: string, oldPassword?: string): Promise<boolean> {
    const existingHash = getSetting(SETTING_PASSWORD_HASH);

    // If a password exists, verify the old one first
    if (existingHash !== null) {
      if (!oldPassword) return false;
      const valid = await Bun.password.verify(oldPassword, existingHash);
      if (!valid) return false;
    }

    const hash = await Bun.password.hash(newPassword, { algorithm: 'bcrypt', cost: 10 });
    setSetting(SETTING_PASSWORD_HASH, hash);
    logger.info('Lock password updated');
    return true;
  }

  /** Remove the password entirely. Requires the current password. */
  async removePassword(currentPassword: string): Promise<boolean> {
    const existingHash = getSetting(SETTING_PASSWORD_HASH);
    if (existingHash === null) return true; // Already no password

    const valid = await Bun.password.verify(currentPassword, existingHash);
    if (!valid) return false;

    // Remove password and unlock
    setSetting(SETTING_PASSWORD_HASH, '');
    setSetting(SETTING_LOCK_ENABLED, 'false');
    this.notifyListeners(false);
    logger.info('Lock password removed, lock disabled');
    return true;
  }

  /** Lock the settings. Only works if a password has been set. */
  lock(): boolean {
    if (!this.hasPassword()) return false;
    setSetting(SETTING_LOCK_ENABLED, 'true');
    this.notifyListeners(true);
    logger.info('Settings locked');
    return true;
  }

  /** Unlock with password. Returns true if password is correct. */
  async unlock(password: string): Promise<boolean> {
    const hash = getSetting(SETTING_PASSWORD_HASH);
    if (hash === null || hash === '') {
      // No password set — always unlocked
      setSetting(SETTING_LOCK_ENABLED, 'false');
      this.notifyListeners(false);
      return true;
    }

    const valid = await Bun.password.verify(password, hash);
    if (!valid) return false;

    setSetting(SETTING_LOCK_ENABLED, 'false');
    this.notifyListeners(false);
    logger.info('Settings unlocked');
    return true;
  }

  /** Subscribe to lock state changes */
  onLockChange(listener: (locked: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(locked: boolean): void {
    for (const listener of this.listeners) {
      try { listener(locked); }
      catch (e) { logger.error('Lock listener error:', e); }
    }
  }
}
