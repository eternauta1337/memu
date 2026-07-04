// Migración puntual: reescribe los mensajes ya guardados en formato `@lid` (los que se
// ingirieron en vivo antes del fix de identidad) a su JID de teléfono canónico, usando el mapa
// LID↔teléfono de whatsmeow. Deja lo vivo consistente con el histórico (mismo chat_jid por
// contacto). Los embeddings no se tocan (van por rowid).
//
//   pnpm migrate-lids           # dry-run: muestra qué cambiaría
//   pnpm migrate-lids --apply   # aplica los cambios

import "./env.ts";
import { openLidMap } from "./lidmap.ts";
import { getStore } from "./store.ts";
import { DEFAULT_USER_ID, wacliStoreDir } from "./users.ts";

const STORE = wacliStoreDir(DEFAULT_USER_ID);

function main(): void {
  const apply = process.argv.includes("--apply");
  const store = getStore(DEFAULT_USER_ID);
  const lidmap = openLidMap(STORE);

  // JIDs @lid distintos presentes en messages (como chat o como sender).
  const lids = new Set<string>();
  for (const col of ["chat_jid", "sender_jid"]) {
    for (const r of store.db.prepare(`SELECT DISTINCT ${col} AS j FROM messages WHERE ${col} LIKE '%@lid'`).all() as Array<{ j: string }>) {
      lids.add(r.j);
    }
  }

  const resolved: Array<{ from: string; to: string }> = [];
  const unresolved: string[] = [];
  for (const lid of lids) {
    const pn = lidmap.resolve(lid);
    if (pn !== lid) resolved.push({ from: lid, to: pn });
    else unresolved.push(lid);
  }

  console.log(`@lid distintos: ${lids.size} · resueltos: ${resolved.length} · sin mapeo: ${unresolved.length}`);
  for (const { from, to } of resolved) {
    const n = (store.db.prepare("SELECT count(*) AS n FROM messages WHERE chat_jid = ? OR sender_jid = ?").get(from, from) as { n: number }).n;
    console.log(`  ${from} → ${to}  (${n} msgs)`);
  }
  if (unresolved.length) console.log(`  sin mapeo (se dejan igual): ${unresolved.join(", ")}`);

  if (!apply) {
    console.log("\n(dry-run) Nada escrito. Corré con --apply para aplicar.");
    lidmap.close();
    return;
  }

  const migrate = store.db.transaction((pairs: Array<{ from: string; to: string }>) => {
    const updChat = store.db.prepare("UPDATE messages SET chat_jid = ? WHERE chat_jid = ?");
    const updSender = store.db.prepare("UPDATE messages SET sender_jid = ? WHERE sender_jid = ?");
    let changed = 0;
    for (const { from, to } of pairs) {
      changed += updChat.run(to, from).changes;
      changed += updSender.run(to, from).changes;
    }
    return changed;
  });
  const changed = migrate(resolved);
  console.log(`\n✅ aplicado: ${changed} filas actualizadas (chat_jid + sender_jid).`);
  lidmap.close();
}

main();
