// Store backed by the local test Postgres, shaped like PostgREST responses (rows as JSON).
import type { SQL } from "bun";
import { TABLES, type Row, type Store, type Table } from "../../lib/store";

function assertTable(t: string): asserts t is Table {
  if (!(TABLES as readonly string[]).includes(t)) throw new Error(`unknown table ${t}`);
}

export function bunStore(sql: SQL): Store {
  const signatures = new Map<string, Map<string, string>>();

  async function argTypes(fn: string) {
    if (!signatures.has(fn)) {
      const rows = await sql`
        select a.name, format_type(a.type, null) as type
        from pg_proc p, unnest(p.proargnames, p.proargtypes::oid[]) as a(name, type)
        where p.proname = ${fn}`;
      signatures.set(fn, new Map(rows.map((r: any) => [r.name, r.type])));
    }
    return signatures.get(fn)!;
  }

  return {
    async rpc<T>(fn: string, args: Record<string, unknown> = {}) {
      if (!/^trk_\w+$/.test(fn)) throw new Error(`bad function ${fn}`);
      const types = await argTypes(fn);
      const params: unknown[] = [];
      const named = Object.entries(args).map(([k, v]) => {
        const type = types.get(k);
        if (!type) throw new Error(`${fn} has no argument ${k}`);
        if (v === null || v === undefined) return `${k} => null::${type}`;
        params.push(type === "jsonb" ? JSON.stringify(v) : String(v));
        return `${k} => $${params.length}::text::${type}`;
      });
      const rows = await sql.unsafe(`select to_jsonb(${fn}(${named.join(", ")})) as r`, params);
      return rows[0].r as T;
    },
    async list<T>(table: Table) {
      assertTable(table);
      const rows = await sql.unsafe(`select to_jsonb(t) as r from ${table} t where deleted_at is null order by created_at`);
      return rows.map((r: any) => r.r) as T[];
    },
    async get<T>(table: Table, id: string) {
      assertTable(table);
      const rows = await sql.unsafe(`select to_jsonb(t) as r from ${table} t where id = $1::uuid`, [id]);
      return (rows[0]?.r ?? null) as T | null;
    },
    async insert<T>(table: Table, row: Row) {
      assertTable(table);
      const cols = Object.keys(row).filter((k) => /^[a-z0-9_]+$/.test(k));
      const list = cols.join(", ");
      const rows = await sql.unsafe(
        `insert into ${table} as t (${list}) select ${list} from jsonb_populate_record(null::${table}, $1::text::jsonb) returning to_jsonb(t) as r`,
        [JSON.stringify(row)],
      );
      return rows[0].r as T;
    },
    async update<T>(table: "trk_messages", id: string, patch: Row) {
      const cols = Object.keys(patch).filter((k) => /^[a-z0-9_]+$/.test(k));
      const set = cols.map((c) => `${c} = r.${c}`).join(", ");
      const rows = await sql.unsafe(
        `update ${table} t set ${set} from jsonb_populate_record(null::${table}, $1::text::jsonb) r where t.id = $2::uuid returning to_jsonb(t) as r`,
        [JSON.stringify(patch), id],
      );
      return rows[0].r as T;
    },
  };
}
