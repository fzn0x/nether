/** A value that crosses between a plugin and the app unchanged: what JSON can write. */
export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
