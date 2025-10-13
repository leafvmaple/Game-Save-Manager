/**
 * Type declarations for placeholderMapping and placeholderIdentifier
 * These objects are used to map template placeholders to actual paths
 */

declare module './global' {
  export const placeholderMapping: { [key: string]: string };
  export const placeholderIdentifier: { [key: string]: string };
}
