// Herramientas del agente Memu. Cada una tiene un spec (formato OpenAI, lo que gemma entiende)
// y un ejecutor que corre contra el store. El loop del agente (agent.ts) las ofrece, gemma
// decide cuáles llamar y con qué argumentos, y encadena pasos hasta responder.

import { portalUrl } from "./billing.ts";
import { getRegistry } from "./registry.ts";
import { fmtWhen, nextFire, reminderFromFields } from "./reminders.ts";
import { pendingChats, readChat, recentChats, searchMessages } from "./retrieval.ts";
import type { MemuStore } from "./store.ts";
import type { ToolSpec } from "./llm.ts";

export const TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "buscar_mensajes",
      description:
        "Busca en TODO el WhatsApp de la persona (histórico + reciente) por significado y palabras clave. Usala para responder sobre temas, personas o grupos puntuales.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "qué buscar, en lenguaje natural" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_chats",
      description: "Lista los chats con actividad más reciente (para '¿qué está pasando?').",
      parameters: {
        type: "object",
        properties: { limite: { type: "integer", description: "cuántos chats (default 12)" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "leer_chat",
      description: "Trae los últimos mensajes de un chat por su nombre (persona o grupo).",
      parameters: {
        type: "object",
        properties: {
          nombre: { type: "string", description: "nombre del chat o grupo" },
          limite: { type: "integer", description: "cuántos mensajes (default 14)" },
        },
        required: ["nombre"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pendientes",
      description:
        "Lista chats donde el último mensaje NO es tuyo (parece que están esperando tu respuesta).",
      parameters: {
        type: "object",
        properties: { limite: { type: "integer", description: "cuántos (default 15)" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recordar",
      description:
        "Guarda un dato permanente sobre la persona o su mundo para acordártelo siempre (ej: 'mi mamá es Marta', 'el grupo Los Pibes es mi grupo de amigos'). Usala cuando te enseñe algo sobre sí misma o su gente.",
      parameters: {
        type: "object",
        properties: { hecho: { type: "string", description: "el dato a recordar, en una frase" } },
        required: ["hecho"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "crear_recordatorio",
      description:
        "Agenda un recordatorio que te va a llegar al self-chat en el momento indicado. Interpretá vos la fecha/hora respecto del AHORA que está en el system prompt.",
      parameters: {
        type: "object",
        properties: {
          texto: { type: "string", description: "qué recordar, breve (ej: 'Llamar a Pau')" },
          fire_at: {
            type: "string",
            description: "fecha y hora local de la primera vez, formato YYYY-MM-DDTHH:MM",
          },
          recurrencia: {
            type: "string",
            description:
              "opcional: 'daily' (todos los días), 'weekdays' (lun-vie), 'weekly:N' (N=0 dom..6 sáb). Omitir si es una sola vez.",
          },
          accion: {
            type: "string",
            description: "'digest' si lo que pide es el resumen del día a esa hora; si no, omitir.",
          },
        },
        required: ["texto", "fire_at"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_recordatorios",
      description: "Lista los recordatorios pendientes (con su id, para poder cancelarlos).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cancelar_recordatorio",
      description: "Cancela un recordatorio pendiente por su id.",
      parameters: {
        type: "object",
        properties: { id: { type: "integer", description: "id del recordatorio" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gestionar_suscripcion",
      description:
        "Devuelve un link al portal de Stripe donde la persona gestiona su suscripción: cambiar la tarjeta, ver facturas, o CANCELAR / darse de baja. Usalo cuando pida gestionar el pago/suscripción, cambiar la tarjeta, ver sus facturas, cancelar o darse de baja.",
      parameters: { type: "object", properties: {} },
    },
  },
];

/** Ejecuta una tool por nombre. Devuelve texto (el resultado que se le devuelve al modelo).
 *  Nunca tira: los errores vuelven como texto para que el agente pueda seguir. */
export async function runTool(
  store: MemuStore,
  names: Map<string, string>,
  name: string,
  argsJson: string,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch {
    return "Error: argumentos inválidos (no es JSON).";
  }
  const str = (k: string): string => String(args[k] ?? "").trim();
  const int = (k: string, def: number): number => {
    const n = Number(args[k]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
  };

  try {
    switch (name) {
      case "buscar_mensajes":
        return await searchMessages(store, str("query"), names);
      case "listar_chats":
        return recentChats(store, names, int("limite", 12));
      case "leer_chat":
        return readChat(store, names, str("nombre"), int("limite", 14));
      case "pendientes":
        return pendingChats(store, names, int("limite", 15));
      case "recordar": {
        const hecho = str("hecho");
        if (!hecho) return "Error: falta el hecho a recordar.";
        store.addFact(hecho);
        return `Anotado: "${hecho}".`;
      }
      case "crear_recordatorio": {
        const r = reminderFromFields({
          text: str("texto"),
          action: str("accion") || undefined,
          fire_at: str("fire_at"),
          recurrence: str("recurrencia") || undefined,
        });
        if (!r) return "Error: no pude interpretar la fecha/hora (necesito YYYY-MM-DDTHH:MM).";
        const id = store.addReminder(r);
        return `Recordatorio #${id} creado: "${r.text}" — ${fmtWhen(r.fireAt, r.recurrence ?? null)}.`;
      }
      case "listar_recordatorios": {
        const rs = store.pendingReminders();
        if (rs.length === 0) return "No tenés recordatorios pendientes.";
        return rs.map((r) => `#${r.id}: "${r.text}" — ${fmtWhen(r.fireAt, r.recurrence)}`).join("\n");
      }
      case "cancelar_recordatorio": {
        const id = int("id", 0);
        if (!id) return "Error: falta el id.";
        return store.cancelReminder(id) ? `Recordatorio #${id} cancelado.` : `No hay recordatorio pendiente #${id}.`;
      }
      case "gestionar_suscripcion": {
        const u = getRegistry().getUser(Number(store.userId));
        if (!u?.stripeCustomerId) {
          return "La persona no tiene una suscripción de Stripe asociada (puede ser cortesía). No hay portal para mostrarle; explicáselo con tacto.";
        }
        const url = await portalUrl(u.stripeCustomerId);
        if (!url) return "No se pudo generar el link del portal ahora. Pedile que reintente en un minuto.";
        return `LINK DEL PORTAL (pegalo EXACTO, sin acortar ni modificar): ${url}\nAhí puede cambiar la tarjeta, ver facturas o cancelar. El link vence en un rato.`;
      }
      default:
        return `Error: herramienta desconocida "${name}".`;
    }
  } catch (e) {
    return `Error ejecutando ${name}: ${(e as Error).message}`;
  }
}

// Reexporto lo que el scheduler necesita para disparar reminders recurrentes.
export { nextFire };
