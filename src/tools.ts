// Herramientas del agente Memu. Cada una tiene un spec (formato OpenAI, lo que gemma entiende)
// y un ejecutor que corre contra el store. El loop del agente (agent.ts) las ofrece, gemma
// decide cuáles llamar y con qué argumentos, y encadena pasos hasta responder.

import { portalUrl } from "./billing.ts";
import { getRegistry } from "./registry.ts";
import { fmtWhen, nextFire, reminderFromFields } from "./reminders.ts";
import {
  fmtDue,
  fmtTaskList,
  normalizeDue,
  normalizePriority,
  normalizeStatus,
  PRIORITY_LABEL,
  STATUS_LABEL,
} from "./tasks.ts";
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
      name: "crear_tarea",
      description:
        "Anota una tarea en la lista de pendientes de la persona (ej: 'comprar el regalo de Marta'). La lista NO avisa sola: si la persona quiere que le AVISES en un momento dado, usá crear_recordatorio en vez de esta.",
      parameters: {
        type: "object",
        properties: {
          texto: { type: "string", description: "la tarea, breve (ej: 'Comprar regalo de Marta')" },
          prioridad: {
            type: "string",
            description: "opcional: 'baja', 'media' o 'alta'. Omitir si la persona no la indica (queda media).",
          },
          fecha_limite: {
            type: "string",
            description: "opcional: fecha límite YYYY-MM-DD (solo ordena la lista, no avisa). Omitir si no tiene.",
          },
        },
        required: ["texto"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_tareas",
      description:
        "Lista las tareas vivas de la persona, agrupadas por estado (en progreso, activas, pendientes), con su #id.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "actualizar_tarea",
      description:
        "Cambia el estado y/o la prioridad de una tarea, por su id. Para marcarla hecha usá completar_tarea.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer", description: "id de la tarea" },
          estado: { type: "string", description: "opcional: 'pendiente', 'activa' o 'en progreso'" },
          prioridad: { type: "string", description: "opcional: 'baja', 'media' o 'alta'" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "completar_tarea",
      description: "Marca una tarea como HECHA, por su id.",
      parameters: {
        type: "object",
        properties: { id: { type: "integer", description: "id de la tarea" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "descartar_tarea",
      description: "Descarta una tarea que ya no aplica o que la persona abandonó (NO la hizo), por su id.",
      parameters: {
        type: "object",
        properties: { id: { type: "integer", description: "id de la tarea" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aceptar_sugerencia",
      description:
        "Acepta una sugerencia de tarea del REM (el repaso nocturno de los chats), por su id de sugerencia: la anota como tarea real.",
      parameters: {
        type: "object",
        properties: { id: { type: "integer", description: "id de la sugerencia" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rechazar_sugerencia",
      description:
        "Rechaza una sugerencia de tarea del REM, por su id de sugerencia. No se la vuelve a proponer nunca.",
      parameters: {
        type: "object",
        properties: { id: { type: "integer", description: "id de la sugerencia" } },
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
      case "crear_tarea": {
        const texto = str("texto");
        if (!texto) return "Error: falta el texto de la tarea.";
        const fecha = str("fecha_limite");
        const dueAt = normalizeDue(fecha || null);
        if (fecha && !dueAt) return "Error: no pude interpretar la fecha límite (necesito YYYY-MM-DD).";
        const prio = str("prioridad");
        const priority = normalizePriority(prio || null);
        if (prio && !priority) return "Error: prioridad inválida (baja, media o alta).";
        const id = store.addTask({ text: texto, priority: priority ?? "medium", dueAt });
        const extras = [priority && priority !== "medium" ? `prioridad ${PRIORITY_LABEL[priority]}` : "", dueAt ? fmtDue(dueAt) : ""]
          .filter(Boolean)
          .join(", ");
        return `Tarea #${id} anotada: "${texto}"${extras ? ` — ${extras}` : ""}.`;
      }
      case "listar_tareas": {
        const ts = store.openTasks();
        if (ts.length === 0) return "No tenés tareas vivas.";
        return fmtTaskList(ts);
      }
      case "actualizar_tarea": {
        const id = int("id", 0);
        if (!id) return "Error: falta el id.";
        const estado = str("estado");
        const status = normalizeStatus(estado || null);
        if (estado && !status) return "Error: estado inválido (pendiente, activa o en progreso; para cerrarla usá completar_tarea o descartar_tarea).";
        const prio = str("prioridad");
        const priority = normalizePriority(prio || null);
        if (prio && !priority) return "Error: prioridad inválida (baja, media o alta).";
        if (!status && !priority) return "Error: no me pasaste nada para cambiar (estado y/o prioridad).";
        if (!store.updateTask(id, { status: status ?? undefined, priority: priority ?? undefined })) {
          return `No hay tarea viva #${id}.`;
        }
        const cambios = [status ? `estado ${STATUS_LABEL[status]}` : "", priority ? `prioridad ${PRIORITY_LABEL[priority]}` : ""]
          .filter(Boolean)
          .join(", ");
        return `Tarea #${id} actualizada: ${cambios}.`;
      }
      case "completar_tarea": {
        const id = int("id", 0);
        if (!id) return "Error: falta el id.";
        return store.closeTask(id, "done") ? `Tarea #${id} completada.` : `No hay tarea abierta #${id}.`;
      }
      case "descartar_tarea": {
        const id = int("id", 0);
        if (!id) return "Error: falta el id.";
        return store.closeTask(id, "dropped") ? `Tarea #${id} descartada.` : `No hay tarea abierta #${id}.`;
      }
      case "aceptar_sugerencia": {
        const id = int("id", 0);
        if (!id) return "Error: falta el id.";
        const s = store.getTaskSuggestion(id);
        if (!s || s.status !== "proposed") return `No hay sugerencia pendiente #${id}.`;
        store.resolveTaskSuggestion(id, "accepted");
        const tid = store.addTask({ text: s.text, dueAt: s.dueAt, chatJid: s.chatJid, sourceMsgId: s.sourceMsgId });
        return `Sugerencia #${id} aceptada → tarea #${tid}: "${s.text}"${s.dueAt ? ` — ${fmtDue(s.dueAt)}` : ""}.`;
      }
      case "rechazar_sugerencia": {
        const id = int("id", 0);
        if (!id) return "Error: falta el id.";
        return store.resolveTaskSuggestion(id, "rejected")
          ? `Sugerencia #${id} rechazada (no la vuelvo a proponer).`
          : `No hay sugerencia pendiente #${id}.`;
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
