import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";
import { DbError, type Row, type Store, type Table } from "./store";

let client: SupabaseClient | undefined;

function db(): SupabaseClient {
  client ??= createClient(env().SUPABASE_URL, env().SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: ((input, init) => fetch(input, { ...init, cache: "no-store" })) as typeof fetch },
  });
  return client;
}

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new DbError(res.error.message);
  return res.data;
}

export function supabaseStore(): Store {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown> = {}) {
      return check(await db().rpc(fn, args)) as T;
    },
    async list<T>(table: Table) {
      return check(await db().from(table).select("*").is("deleted_at", null).order("created_at")) as T[];
    },
    async get<T>(table: Table, id: string) {
      return check(await db().from(table).select("*").eq("id", id).maybeSingle()) as T | null;
    },
    async insert<T>(table: Table, row: Row) {
      return check(await db().from(table).insert(row).select().single()) as T;
    },
    async update<T>(table: "trk_messages", id: string, patch: Row) {
      return check(await db().from(table).update(patch).eq("id", id).select().single()) as T;
    },
  };
}
