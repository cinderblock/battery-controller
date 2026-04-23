/**
 * Profile registry.
 *
 * Add new profiles here. Each must satisfy the Profile interface in
 * ./types.ts. The registry is keyed by the profile's `name` field.
 */

import { ebcA40LProfile } from './ebc-a40l.ts';
import type { Profile } from './types.ts';

export type { Profile } from './types.ts';

export const profiles = {
  'ebc-a40l': ebcA40LProfile,
} as const satisfies Record<string, Profile>;

export type ProfileName = keyof typeof profiles;

export function getProfile(name: string): Profile {
  const profile = (profiles as Record<string, Profile>)[name];
  if (!profile) {
    const available = Object.keys(profiles).join(', ');
    throw new Error(`Unknown profile '${name}'. Available: ${available}`);
  }
  return profile;
}
