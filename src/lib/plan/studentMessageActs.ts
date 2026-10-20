// src/lib/plan/studentMessageActs.ts
//
// Lo que HACE un mensaje del estudiante, aparte de los datos que trae: rechazar, aplazar, delegar
// la decisión, dudar, corregir, negar, quedarse en lo vago o cambiar de caso. Pensado para todas
// las etapas: hoy lo usa la Etapa 0 (stage0Context.ts y stage0Values.ts); E1-E10 pueden adoptarlo
// cuando se revisen. Puro, sin estado, I/O ni LLM: sirve igual en el navegador y en el servidor.
//
// El mensaje se lee por cláusulas, que separan los signos (, ; . ! ? ¡ ¿) y "pero", "sino" y
// "aunque". Cada cláusula se clasifica por su forma, no por una lista de frases completas:
//   - rechazo: un verbo de decir o compartir negado, "prefiero no…", o algo calificado de
//     confidencial o privado ("prefiero no decirlo", "eso es confidencial");
//   - aplazamiento: "todavía/aún no" con un verbo de decidir o saber, "lo estoy pensando",
//     "luego te digo", "tengo que consultarlo";
//   - delegación: la decisión queda en el asesor ("el que tú me recomiendes", "elige tú",
//     "cualquiera") o en otra persona ("pregúntale a mi supervisor");
//   - vaguedad: solo cuantificadores ("muchos", "ninguno en especial") o un criterio en lugar de
//     un valor ("depende de la temporada", "donde hay más problemas");
//   - cambio de caso: "cambiar de empresa", "otro caso", "empezar de cero";
//   - negación: "no" con un verbo ("no es X", "no la fabricamos") o al comienzo de una cláusula
//     ("leche, no yogur"). Lo negado se devuelve aparte y nunca cuenta como dato; con "era" o
//     "fue" es además una corrección ("no era yogur sino queso");
//   - duda ("no sé", "no estoy seguro") y tentativa ("creo que", "puede ser"): se quita la
//     expresión y lo que queda puede ser un dato dicho con duda;
//   - corrección: "me equivoqué", "corrijo", "mejor dicho" o un verbo de cambiar en cualquier
//     forma ("cambiemos", "cámbialo", "corrige");
//   - desistir de un cambio: "déjalo así", "mejor no", "olvídalo";
//   - marcas de conversación que no aportan: "ya te dije", "mi supervisor dice que", "perdón",
//     "bueno", y un "sí" o "no" suelto al comienzo.
// content es el mensaje con todo eso en blanco, letra por letra (mismas posiciones), para que la
// extracción de cada etapa lea solo lo que el estudiante afirma.

export type StudentMessageActs = {
  refusal: boolean;
  deferral: boolean;
  // A quién deja la decisión: al asesor o a otra persona.
  delegation: "advisor" | "third_party" | null;
  vague: boolean;
  contextChange: boolean;
  correction: boolean;
  negation: boolean;
  uncertain: boolean;
  // "creo que", "puede ser"… (la duda sobre un dato que sí se dice).
  hedged: boolean;
  // Un "no" o un "sí" suelto al comienzo ("No, mejor…", "Sí, creo que…").
  disagrees: boolean;
  agrees: boolean;
  // Desiste de un cambio que había pedido ("déjalo así", "mejor no", "olvídalo").
  cancel: boolean;
};

export type StudentMessageReading = {
  // El mensaje en NFC.
  source: string;
  // source con en blanco lo que no es un dato afirmado (mismas posiciones).
  content: string;
  // Lo negado, tal como lo escribió el estudiante ("no era yogur" -> "no era yogur").
  negated: string[];
  acts: StudentMessageActs;
};

// Minúsculas y sin tildes, letra por letra: cada posición coincide con la del texto original.
export function foldSpanish(text: string) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    const folded = ch.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    out += folded.length === 1 ? folded : ch;
  }
  return out;
}

// Verbos de cambiar o corregir, en cualquier persona y con los pronombres pegados. No entran los
// sustantivos ("cambio de aceite", "la corrección").
export const EDIT_VERB_SOURCE =
  "(?:cambi(?:ar|arlo|arla|arlos|a|alo|ala|ame|e|en|emos|amos|ado|ada|aria)|" +
  "corrig(?:e|elo|ela|en|i|io|iendo)|correg(?:ir|irlo|imos|ido)|corrij(?:o|a|amos|as)|" +
  "modific(?:ar|arlo|a|alo|amos|ado)|modifiqu(?:e|emos)|actualiz(?:ar|arlo|a|alo|amos|ado)|actualic(?:e|emos)|" +
  "edit(?:ar|arlo|a|alo|emos|amos|ado)|arregl(?:ar|arlo|a|alo|emos|amos|ado)|" +
  "reemplaz(?:ar|arlo|a|alo|amos)|reemplac(?:e|emos)|sustitu(?:ir|ye|imos))";
const EDIT_VERB = new RegExp(`\\b${EDIT_VERB_SOURCE}\\b`);

const PERSON_ROLE = "(?:supervisor\\w*|jef[ea]s?|tutor\\w*|encargad[oa]s?|gerente|docente|ingenier[oa]|licenciad[oa]|duen[oa]|profesor\\w*)";
const OWNER = "(?:mi|mis|el|la|los|las|nuestro|nuestra)";

// ---- Cláusulas enteras que no traen un dato ----

const CONTEXT_CHANGE = new RegExp(
  "\\b(?:cambi\\w*\\s+(?:de\\s+)?(?:empresa|compania|practica|caso)|(?:otra|nueva|distinta|diferente)\\s+(?:empresa|compania|practica)|" +
    "otro\\s+caso|(?:empezar|comenzar|iniciar|empecemos|comencemos|empiezo)\\s+(?:de\\s+(?:nuevo|cero)|otra\\s+vez)|" +
    "reinici\\w*|borr\\w*\\s+(?:todo|el\\s+contexto))\\b"
);

const SHARE_VERB = "(?:decir|compartir|dar|revelar|mencionar|contar|responder|contestar|brindar|proporcionar|divulgar|publicar|nombrar)\\w*";
const PRIVATE_WORD = "(?:confidencial\\w*|privad[oa]s?|reservad[oa]s?|secret[oa]s?|sensible\\w*)";
const REFUSAL = new RegExp(
  [
    "\\b(?:prefier(?:o|e|en)|prefer(?:imos|iria|iriamos))\\s+no\\b",
    `\\bno\\s+(?:(?:te|le|les)\\s+)?(?:lo\\s+|la\\s+|eso\\s+)?(?:puedo|podemos|podria|quiero|queremos|debo|debemos|deberia|me\\s+(?:permiten|dejan|autorizan)|nos\\s+(?:permiten|dejan|autorizan)|estoy\\s+autorizad[oa]|tengo\\s+permiso(?:\\s+para)?|esta\\s+permitido)\\s+(?:(?:te|le|les)\\s+)?${SHARE_VERB}`,
    `\\b(?:es|son|seria|eso\\s+es|esa\\s+(?:informacion|parte)\\s+es)\\s+(?:informacion\\s+|un\\s+dato\\s+|algo\\s+)?${PRIVATE_WORD}\\b`,
    `^(?:es\\s+)?(?:informacion\\s+)?${PRIVATE_WORD}$`,
    `\\b(?:informacion|datos?)\\s+${PRIVATE_WORD}\\b`,
    "\\bsin\\s+comentarios\\b",
    "\\bme\\s+pidieron\\s+(?:que\\s+)?no\\b",
    "\\bno\\s+(?:quiero|deseo)\\s+(?:responder|contestar|hablar\\s+de\\s+eso)\\b",
  ].join("|")
);

const DEFERRAL = new RegExp(
  [
    "\\b(?:todavia|aun)\\s+no\\s+(?:(?:lo|la|los|las|me|nos|se|le)\\s+)?(?:(?:he|hemos|han)\\s+)?" +
      "(?:decid\\w*|defin\\w*|eleg\\w*|elij\\w*|escog\\w*|asign\\w*|indic\\w*|dij\\w*|confirm\\w*|pens\\w*|sab\\w*|se|conozc\\w*|" +
      "tengo\\s+(?:claro|definid\\w*|decidid\\w*)|estoy\\s+segur\\w*)\\b",
    "\\bno\\s+(?:lo|la)\\s+(?:he\\s+|hemos\\s+)?(?:decid|defin|eleg|escog|pens)\\w*",
    "\\b(?:lo|la)\\s+(?:estoy|estamos)\\s+(?:pensando|viendo|evaluando|decidiendo|definiendo)\\b",
    "\\b(?:aun|todavia)\\s+(?:lo\\s+)?(?:estoy\\s+|estamos\\s+)?(?:decidiendo|definiendo|pensando|evaluando)\\b",
    "\\b(?:luego|despues|mas\\s+tarde|mas\\s+adelante|otro\\s+dia|manana|en\\s+otro\\s+momento)\\s+(?:te\\s+|se\\s+)?(?:lo\\s+)?" +
      "(?:digo|cuento|aviso|confirmo|respondo|defino|decido|vemos|veo|paso|escribo|completo)\\b",
    "\\b(?:te|se)\\s+(?:lo\\s+)?(?:digo|confirmo|aviso|cuento|escribo)\\s+(?:luego|despues|mas\\s+tarde|manana|mas\\s+adelante|en\\s+otro\\s+momento)\\b",
    "\\b(?:tengo|tenemos)\\s+que\\s+(?:consultar|preguntar|averiguar|confirmar|ver|revisar|pensar|decidir)\\w*",
    "\\b(?:lo\\s+)?(?:consulto|pregunto|averiguo|reviso)\\s+(?:y\\s+)?(?:te\\s+)?(?:aviso|digo|cuento|confirmo|escribo)\\b",
  ].join("|")
);

const DELEGATE_TO_ADVISOR = new RegExp(
  [
    "\\b(?:el|la|lo|los|las)\\s+que\\s+(?:(?:tu|usted)\\s+)?(?:me\\s+|nos\\s+)?(?:recomiend|sugier|aconsej|dig|eli[jg]|prefier|quier|cre|consider|parezc)\\w*",
    "\\b(?:tu|usted)\\s+(?:elige|elija|decide|decida|escoge|escoja|dime|recomiendame|sabes|sabras|veras)\\b",
    "^(?:elige|elijelo|eligelo|decide|decidelo|escoge|escogelo)(?:\\s+(?:tu|usted))?$",
    "\\bque\\s+(?:\\w+\\s+){0,2}(?:me|nos)\\s+(?:recomiend|sugier|aconsej)\\w*",
    "\\b(?:recomiendame|sugiereme|aconsejame)\\w*",
    "\\blo\\s+que\\s+(?:tu\\s+)?(?:quieras|digas|prefieras|creas|consideres)\\b",
    "\\bcomo\\s+(?:tu\\s+)?(?:quieras|prefieras|veas|consideres)\\b",
    "^cualquier(?:a|\\s+(?:cosa|opcion|area|proceso|producto|servicio|rubro))$",
    "\\b(?:me\\s+)?da\\s+(?:igual|lo\\s+mismo)\\b",
  ].join("|")
);
const DELEGATE_TO_OTHER = new RegExp(
  [
    `\\b(?:pregunta|preguntale|preguntales|consulta|consultale|consultales|habla)\\s+(?:a|con)\\s+${OWNER}\\b`,
    "\\bpreguntale\\b|\\bconsultale\\b",
    `\\b${OWNER}\\s+${PERSON_ROLE}\\s+(?:te\\s+)?(?:lo\\s+)?(?:sabe|sabra|sabria|dira|puede\\s+decir\\w*|te\\s+puede\\s+decir|tiene\\s+(?:esa|la)\\s+informacion)\\b`,
  ].join("|")
);

// Un criterio en lugar de un valor ("depende…", "donde hay más problemas", "el que más venda").
const VAGUE_HEAD =
  /^(?:depende\w*|segun\s+(?:la|el|lo)|lo\s+que\s+(?:sea|salga|haya)|de\s+todo(?:\s+un\s+poco)?|un\s+poco\s+de\s+todo|(?:en\s+)?donde\s+(?:hay|haya|tenga|tengan|existan?|se\s+necesit\w*)|(?:el|la|los|las)\s+que\s+(?:mas\s+)?(?:tenga|tengan|haya|venda|vendan|necesite|necesiten))\b/;
// Cuantificadores e indefinidos: una cláusula hecha solo de esto (y de palabras de relleno) no
// nombra nada ("muchos", "ninguno en especial", "tenemos varios").
const VAGUE_WORDS = new Set([
  "muchos", "muchas", "mucho", "varios", "varias", "todos", "todas", "todo", "ninguno", "ninguna", "ningun", "nada",
  "especial", "particular", "concreto", "general", "otros", "otras", "demas", "diversos", "diversas", "distintos",
  "distintas", "diferentes", "cosas", "cosa", "algo", "algunos", "algunas", "bastantes", "poco", "pocos", "normal",
]);
const VAGUE_FILLER = new Set([
  "el", "la", "los", "las", "lo", "un", "una", "unos", "unas", "de", "del", "en", "a", "al", "con", "y", "o", "e",
  "que", "pues", "bueno", "realmente", "exactamente", "mas", "muy", "son", "es", "hay", "tenemos", "tiene", "tienen",
  "hacemos", "hace", "hacen", "vendemos", "producimos", "fabricamos", "tipo", "tipos", "clase", "clases",
]);

// ---- Expresiones que se quitan de una cláusula que sí puede traer un dato ----

const REPORTED_SPEECH = new RegExp(
  `^(?:(?:segun|para)\\s+${OWNER}\\s+${PERSON_ROLE}|${OWNER}\\s+${PERSON_ROLE}\\s+(?:me\\s+|nos\\s+)?` +
    "(?:dice|dijo|comenta|comento|indica|indico|menciona|menciono|explica|explico|cree|piensa|asegura|afirma|considera)\\s+que)\\b"
);
const DISCOURSE_FILLER = new RegExp(
  "^(?:bueno|pues|mira|mire|a\\s+ver|este|eh+|mm+|la\\s+verdad(?:\\s+es\\s+que)?|te\\s+(?:comento|cuento|digo)\\s+que|" +
    "como\\s+(?:ya\\s+)?te\\s+(?:dije|comente|conte|mencione|decia)|ya\\s+te\\s+(?:lo\\s+)?(?:dije|comente|conte|mencione|habia\\s+dicho)|" +
    "te\\s+lo\\s+(?:dije|comente)|como\\s+(?:ya\\s+)?(?:dije|mencione|comente)|ya\\s+lo\\s+(?:dije|mencione)|perdon|perdona|" +
    "disculpa|disculpe|disculpame|lo\\s+siento|en\\s+realidad|en\\s+verdad|o\\s+sea|osea)\\b"
);
// "Mejor" al comienzo, cuando corrige: "mejor cambiemos…", "mejor el producto es…".
const BETTER_CORRECTION = new RegExp(`^mejor(?=\\s+(?:dicho\\b|el\\b|la\\b|los\\b|las\\b|pon\\w*|registr\\w*|dej\\w*|${EDIT_VERB_SOURCE}\\b))(?:\\s+dicho)?\\b`);
const CORRECTION_CUE =
  /\b(?:me\s+equivoque|me\s+equivoco|me\s+confundi|me\s+exprese\s+mal|error\s+mio|corrijo|correccion|mejor\s+dicho|rectifico|quise\s+decir|estaba\s+mal|esta\s+mal|esta\s+equivocad[oa]|no\s+es\s+asi|no\s+(?:es|esta)\s+(?:bien|correct[oa])|eso\s+no\s+es\s+(?:asi|correcto))\b/g;
const HEDGE =
  /\b(?:creo\s+que|creo|pienso\s+que|supongo\s+que|supongo|me\s+parece\s+que|parece\s+que|tal\s+vez|quizas?|capaz\s+que|puede\s+ser(?:\s+que)?|podria\s+ser|probablemente|posiblemente|seguramente|imagino\s+que|diria\s+que|mas\s+o\s+menos|si\s+no\s+me\s+equivoco)\b/g;
const UNCERTAINTY =
  /\b(?:nose|no\s+sabria(?:\s+decir(?:te)?)?|no\s+estoy\s+segur[oa]s?|no\s+tengo\s+(?:claro|idea|certeza)|no\s+me\s+queda\s+claro|ni\s+idea|sin\s+idea|no\s+conozco|no\s+recuerdo|tengo\s+dudas?|dudo)\b/g;
// "No sé": con tilde siempre es duda; sin tilde, solo si no sigue un verbo ("no se vende" es una
// negación).
const NO_SE = /\bno\s+(?:lo\s+)?se\b/g;
const NO_SE_FOLLOWERS =
  /^\s*(?:$|que\b|cual\w*|si\b|como\b|donde\b|cuant\w*|bien\b|exactamente\b|muy\b|todavia\b|aun\b|nada\b|mucho\b|realmente\b|con\s+certeza\b)/;

const CANCEL =
  /^(?:(?:no|bueno|mejor)\s+)?(?:dej(?:alo|ala|emoslo|emosla|a\s+eso)(?:\s+(?:asi|como\s+estaba|igual))?|olvid(?:alo|a\s+eso|emoslo)|mejor\s+no|no\s+(?:lo|la)\s+cambies|no\s+importa|cancel\w*|ya\s+no|como\s+estaba|no\s+cambies\s+nada)$/;
const INTERJECTION_NO = /^(?:no|nop|nope|nel|para\s+nada)$/;
const INTERJECTION_YES =
  /^(?:si|sip|claro|ok|okay|okey|vale|dale|correcto|exacto|perfecto|listo|de\s+acuerdo|bueno|ya|(?:asi\s+)?esta\s+bien|todo\s+bien)$/;

const NEGATION = /(?:^|\s)((?:(?:y|e|o|pero|sino|aunque)\s+)?(?:no|ni|nunca|tampoco|jamas))\s+(?:(lo|la|los|las|le|les|se|nos|me|te)\s+)?([a-z]+)/g;
const VERBAL_WORDS = new Set([
  "es", "son", "era", "eran", "fue", "fueron", "sera", "seria", "sea", "esta", "estan", "estamos", "estoy", "hay",
  "habia", "tiene", "tienen", "tenemos", "tengo", "hace", "hacen", "hacemos", "hago", "trabaja", "trabajan",
]);

// "no" seguido de algo que se comporta como verbo: un pronombre pegado, una cópula, o una forma
// verbal frecuente (-mos, -an/-en, -a/-e/-o). Un adjetivo en plural no lo es ("bebidas no
// alcohólicas", "minerales no metálicos").
function negatesVerb(clitic: string | undefined, word: string) {
  if (clitic) return true;
  if (VERBAL_WORDS.has(word)) return true;
  if (/s$/.test(word)) return false;
  return /(?:mos|[aeo]n|ar|er|ir|[aeo])$/.test(word);
}

const CLAUSE_FILLER = new Set([
  "todavia", "aun", "ahora", "ya", "bien", "muy", "mucho", "exactamente", "realmente", "del", "de", "el", "la", "lo",
  "los", "las", "eso", "esto", "si", "no", "pero", "y", "o", "que", "es", "son", "pues", "bueno", "entonces", "igual",
  "tampoco", "mas", "menos", "eh", "mm",
]);

const CLAUSE_BREAK = /[,;.!?¡¿\n()«»"]+|\b(?:pero|sino|aunque)\b/g;
const CLAUSE_LEAD = /^(?:pero|sino|aunque)\b\s*/;

function clauseRanges(folded: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  const push = (s: number, e: number) => {
    if (folded.slice(s, e).trim()) ranges.push([s, e]);
  };
  for (const match of folded.matchAll(CLAUSE_BREAK)) {
    const at = match.index ?? 0;
    if (/^[a-z]/.test(match[0])) {
      // La conjunción abre la cláusula siguiente.
      push(start, at);
      start = at;
    } else {
      push(start, at);
      start = at + match[0].length;
    }
  }
  push(start, folded.length);
  return ranges;
}

function vagueClause(clause: string) {
  if (VAGUE_HEAD.test(clause)) return true;
  const words = clause.split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => VAGUE_WORDS.has(word)) && words.every((word) => VAGUE_WORDS.has(word) || VAGUE_FILLER.has(word));
}

export function readStudentMessage(text: string): StudentMessageReading {
  const source = String(text ?? "").normalize("NFC");
  const folded = foldSpanish(source);
  const work = folded.split("");
  const negated: string[] = [];
  const acts: StudentMessageActs = {
    refusal: false,
    deferral: false,
    delegation: null,
    vague: false,
    contextChange: false,
    correction: false,
    negation: false,
    uncertain: false,
    hedged: false,
    disagrees: false,
    agrees: false,
    cancel: false,
  };

  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i += 1) work[i] = " ";
  };
  const current = (start: number, end: number) => work.slice(start, end).join("");

  clauseRanges(folded).forEach(([start, end], index) => {
    // Posición del texto de la cláusula, sin espacios al comienzo.
    const leading = folded.slice(start, end).match(/^\s*/)?.[0].length ?? 0;
    let s = start + leading;
    const lead = folded.slice(s, end).match(CLAUSE_LEAD);
    const clause = folded.slice(s, end).replace(CLAUSE_LEAD, "").trim();
    const whole = () => blank(start, end);

    if (CONTEXT_CHANGE.test(clause)) {
      acts.contextChange = true;
      whole();
      return;
    }
    if (CANCEL.test(clause)) {
      acts.cancel = true;
      whole();
      return;
    }
    if (REFUSAL.test(clause)) {
      acts.refusal = true;
      whole();
      return;
    }
    if (DEFERRAL.test(clause)) {
      acts.deferral = true;
      whole();
      return;
    }
    if (DELEGATE_TO_OTHER.test(clause)) {
      acts.delegation = acts.delegation ?? "third_party";
      whole();
      return;
    }
    if (DELEGATE_TO_ADVISOR.test(clause)) {
      acts.delegation = "advisor";
      whole();
      return;
    }
    if (INTERJECTION_NO.test(clause)) {
      if (index === 0) acts.disagrees = true;
      whole();
      return;
    }
    if (INTERJECTION_YES.test(clause)) {
      if (index === 0) acts.agrees = true;
      whole();
      return;
    }
    if (vagueClause(clause)) {
      acts.vague = true;
      whole();
      return;
    }

    // La conjunción del comienzo no es parte del dato ("…sino queso").
    if (lead) {
      blank(s, s + lead[0].length);
      s += lead[0].length;
    }

    // Lo que no aporta al comienzo: rellenos, "ya te dije", "mi supervisor dice que", "mejor…".
    let changed = true;
    while (changed) {
      changed = false;
      const rest = current(s, end);
      const offset = rest.match(/^\s*/)?.[0].length ?? 0;
      const head = rest.slice(offset);
      const match = head.match(REPORTED_SPEECH) ?? head.match(DISCOURSE_FILLER) ?? head.match(BETTER_CORRECTION);
      if (match && match[0]) {
        if (BETTER_CORRECTION.test(head)) acts.correction = true;
        blank(s + offset, s + offset + match[0].length);
        s += offset + match[0].length;
        changed = true;
      }
    }

    const blankAll = (pattern: RegExp, onMatch: () => void) => {
      for (const match of current(s, end).matchAll(pattern)) {
        const at = s + (match.index ?? 0);
        onMatch();
        blank(at, at + match[0].length);
      }
    };
    blankAll(CORRECTION_CUE, () => {
      acts.correction = true;
    });
    blankAll(UNCERTAINTY, () => {
      acts.uncertain = true;
    });
    for (const match of current(s, end).matchAll(NO_SE)) {
      const at = s + (match.index ?? 0);
      const after = current(at + match[0].length, end);
      if (/é/i.test(source.slice(at, at + match[0].length)) || NO_SE_FOLLOWERS.test(after)) {
        acts.uncertain = true;
        blank(at, at + match[0].length);
      }
    }
    blankAll(HEDGE, () => {
      acts.hedged = true;
    });

    // Negación: desde el "no" hasta el final de la cláusula. Al comienzo de la cláusula basta el
    // "no" ("leche, no yogur"); en medio, tiene que negar un verbo.
    const rest = current(s, end);
    const restStart = s + (rest.match(/^\s*/)?.[0].length ?? 0);
    for (const match of rest.matchAll(NEGATION)) {
      const word = match[3] ?? "";
      if (/^(?:solo|solamente|tanto)$/.test(word)) continue;
      const at = s + (match.index ?? 0) + (match[0].length - match[0].trimStart().length);
      if (at !== restStart && !negatesVerb(match[2], word)) continue;
      acts.negation = true;
      if (/^(?:era|eran|fue|fueron)$/.test(word)) acts.correction = true;
      negated.push(source.slice(at, end).trim());
      blank(at, end);
      break;
    }

    if (EDIT_VERB.test(current(s, end))) acts.correction = true;

    // Lo que queda de la cláusula son solo adverbios o conectores ("…no estoy seguro todavía").
    const left = current(start, end).split(/[^a-z0-9]+/).filter(Boolean);
    if (left.every((word) => CLAUSE_FILLER.has(word))) whole();
  });

  return { source, content: restoreCase(source, work.join("")), negated, acts };
}

// work está en minúsculas y sin tildes; el contenido conserva el texto original fuera de lo que
// se dejó en blanco.
function restoreCase(source: string, work: string) {
  let out = "";
  for (let i = 0; i < source.length; i += 1) out += work.charAt(i) === " " && source.charAt(i) !== " " ? " " : source.charAt(i);
  return out;
}
