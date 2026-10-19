// Throwaway local Postgres with every repo migration applied, for testing the SQL layer.
// Needs initdb/pg_ctl/psql on PATH (brew install postgresql@16). Never touches Supabase.
import { SQL } from "bun";
import { mkdtempSync, readdirSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dir, "../../supabase/migrations");
const env = { ...process.env, LC_ALL: "en_US.UTF-8" };

function run(cmd: string[]) {
  const r = Bun.spawnSync(cmd, { env, stderr: "pipe", stdout: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}\n${r.stderr.toString()}`);
  return r.stdout.toString();
}

export const hasPostgres = Bun.which("initdb") !== null && Bun.which("pg_ctl") !== null;

export async function startPg() {
  const dir = mkdtempSync(join(tmpdir(), "trkpg-"));
  run(["initdb", "-D", dir, "-U", "postgres", "-A", "trust"]);
  appendFileSync(join(dir, "postgresql.conf"),
    `unix_socket_directories = ''\nlisten_addresses = '127.0.0.1'\nfsync = off\ntimezone = 'UTC'\n`);
  // A random port can collide with another test file's cluster that is still shutting down; retry on a new one.
  let port = 0;
  for (let attempt = 1; ; attempt++) {
    port = 55000 + Math.floor(Math.random() * 5000);
    try {
      run(["pg_ctl", "-D", dir, "-l", join(dir, "log"), "-o", `-p ${port}`, "-w", "start"]);
      break;
    } catch (e) {
      if (attempt >= 4) throw new Error(`${(e as Error).message}\n${Bun.spawnSync(["tail", "-5", join(dir, "log")]).stdout}`);
    }
  }

  const psql = ["psql", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q"];
  // Supabase's API roles, so the grants/revokes in the migrations apply.
  run([...psql, "-c", "create role anon; create role authenticated; create role service_role;"]);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    run([...psql, "-f", join(MIGRATIONS, f)]);
  }

  const sql = new SQL({ hostname: "127.0.0.1", port, username: "postgres", database: "postgres", max: 1 });
  return {
    sql,
    psql: (command: string) => run([...psql, "-At", "-c", command]),
    async stop() {
      await sql.close();
      run(["pg_ctl", "-D", dir, "-m", "immediate", "stop"]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
