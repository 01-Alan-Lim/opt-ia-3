import assert from "node:assert/strict";

import {
  describeChatIdentity,
  formatPersonName,
  getPreferredStudentFirstName,
  primaryGivenName,
  primarySurname,
  readMeIdentity,
} from "../chat/studentIdentity";
import { generalAssistantGreeting } from "../chat/advisorVoice";
import { buildStage0Opening } from "./stage0Context";

// Nombre que muestra el chat (src/lib/chat/studentIdentity.ts): la cabecera dice "Univ. Nombre
// Apellido" y el saludo usa el nombre de pila, a partir del perfil que trae /api/me. Solo da formato:
// el perfil guardado no cambia.

{
  // 1. Perfil en mayúsculas: un nombre y un apellido, con mayúscula inicial.
  assert.deepEqual(
    describeChatIdentity({ firstName: "ALAN MAURICIO", lastName: "LIMACHI MAMANI", role: "student" }),
    { greetingName: "Alan", headerName: "Univ. Alan Limachi" }
  );
}

{
  // 2. Nombres y apellidos compuestos: no se recortan a una palabra.
  assert.deepEqual(
    describeChatIdentity({ firstName: "MARÍA JOSÉ", lastName: "DE LA CRUZ QUISPE", role: "student" }),
    { greetingName: "María José", headerName: "Univ. María José de la Cruz" }
  );
  assert.equal(primaryGivenName("José Luis Fernando"), "José Luis");
  assert.equal(primaryGivenName("juan carlos"), "Juan Carlos");
  assert.equal(primaryGivenName("maría de los ángeles"), "María de los Ángeles");
  assert.equal(primaryGivenName("Alan Mauricio"), "Alan");
  assert.equal(primaryGivenName("ana-lucía"), "Ana-Lucía");
  assert.equal(primarySurname("San Martín López"), "San Martín");
  assert.equal(primarySurname("del río vargas"), "del Río");
  assert.equal(primarySurname("O'CONNOR"), "O'Connor");
  // Las mayúsculas internas escritas a propósito se respetan.
  assert.equal(formatPersonName("Ronald McDonald"), "Ronald McDonald");
}

{
  // 3. Tildes y espacios de más.
  assert.deepEqual(
    describeChatIdentity({ firstName: "  josé   luis ", lastName: "  pérez   ñuflo ", role: "student" }),
    { greetingName: "José Luis", headerName: "Univ. José Luis Pérez" }
  );
  // Una tilde escrita como letra más tilde combinada se muestra igual.
  const acute = String.fromCharCode(0x301);
  assert.equal(describeChatIdentity({ firstName: `Jose${acute}`, lastName: `Pe${acute}rez` }).headerName, "José Pérez");
}

{
  // 4. Sin perfil: el nombre de la cuenta de Google; sin rol conocido, sin "Univ.".
  assert.deepEqual(describeChatIdentity({ accountName: "ALAN LIMACHI", email: "a@b.c" }), {
    greetingName: "Alan",
    headerName: "Alan Limachi",
  });
  // Sin ningún nombre no se arma uno con el correo: la cabecera muestra el correo y el saludo va sin nombre.
  assert.deepEqual(describeChatIdentity({ email: "alimachi.404@gmail.com", role: "student" }), {
    greetingName: null,
    headerName: "alimachi.404@gmail.com",
  });
  assert.deepEqual(describeChatIdentity({}), { greetingName: null, headerName: "" });
  // Solo el apellido: la cabecera lo muestra; el saludo no usa el apellido.
  assert.deepEqual(describeChatIdentity({ lastName: "de la cruz", role: "student" }), {
    greetingName: null,
    headerName: "Univ. De la Cruz",
  });
}

{
  // 5. Cuenta de Google personal o institucional: manda el perfil, no el nombre de la cuenta.
  for (const accountName of ["alan404", "ALAN MAURICIO LIMACHI MAMANI", null]) {
    assert.deepEqual(
      describeChatIdentity({ firstName: "Alan", lastName: "Limachi", role: "student", accountName, email: "a@b.c" }),
      { greetingName: "Alan", headerName: "Univ. Alan Limachi" },
      String(accountName)
    );
  }
  // Un docente no lleva "Univ.".
  assert.equal(describeChatIdentity({ firstName: "rosa", lastName: "quispe", role: "teacher" }).headerName, "Rosa Quispe");
}

{
  // 6. Saludo y cabecera coherentes: el saludo es el comienzo del nombre de la cabecera, y la
  // apertura de E0 saluda con él, sin "Univ.".
  const profiles = [
    { firstName: "ALAN MAURICIO", lastName: "LIMACHI MAMANI" },
    { firstName: "maría josé", lastName: "de la cruz" },
    { firstName: "Ana-Lucía", lastName: "O'Connor" },
  ];
  for (const profile of profiles) {
    const identity = describeChatIdentity({ ...profile, role: "student" });
    assert.ok(identity.headerName.startsWith(`Univ. ${identity.greetingName} `), identity.headerName);
    const opening = buildStage0Opening(1, {}, identity.greetingName);
    assert.ok(opening.startsWith(`¡Hola, ${identity.greetingName}! 👋`), opening);
    assert.ok(!opening.includes("Univ."));
    // El Asistente General saluda con el mismo nombre de pila.
    assert.ok(generalAssistantGreeting(identity.greetingName).startsWith(`¡Hola, ${identity.greetingName}! 👋 Soy OPT-IA`));
  }
}

{
  // Saludo del Asistente General (advisorVoice.ts): con nombre y, sin él, "¡Hola!". No menciona la
  // tecnología interna.
  assert.equal(
    generalAssistantGreeting("Alan"),
    "¡Hola, Alan! 👋 Soy OPT-IA, tu asistente académico. Estoy aquí para acompañarte durante tu Práctica " +
      "Empresarial, resolver tus dudas y orientarte en las actividades que desarrollas en la empresa.\n\n" +
      "¿Por dónde comenzamos?"
  );
  const anonymous = generalAssistantGreeting(null);
  assert.ok(anonymous.startsWith("¡Hola! 👋 Soy OPT-IA,"), anonymous);
  assert.equal(generalAssistantGreeting("   "), anonymous);
  assert.ok(!/supabase|gemini|google|mypes|pasant[ií]a|pr[aá]cticas/i.test(anonymous), anonymous);
  assert.equal((anonymous.match(/¿/g) ?? []).length, 1, "una sola pregunta");
}

{
  // De la respuesta de /api/me solo se leen el nombre, el apellido y el rol.
  assert.deepEqual(
    readMeIdentity({
      user: { userId: "u", email: "e", role: "student" },
      profile: { first_name: "Alan", last_name: "Limachi", ru: "1" },
      gates: { reason: "OK" },
    }),
    { firstName: "Alan", lastName: "Limachi", role: "student" }
  );
  assert.deepEqual(readMeIdentity({ user: { role: "student" }, profile: null }), {
    firstName: null,
    lastName: null,
    role: "student",
  });
  assert.deepEqual(readMeIdentity({ profile: { first_name: "  ", last_name: 3 } }), {
    firstName: null,
    lastName: null,
    role: null,
  });
  assert.equal(readMeIdentity(null), null);
  assert.equal(readMeIdentity("x"), null);
}

{
  // E1-E10 siguen con getPreferredStudentFirstName, sin cambios.
  assert.equal(getPreferredStudentFirstName({ firstName: "ALAN MAURICIO" }), "ALAN");
  assert.equal(getPreferredStudentFirstName({ email: "ana.perez@b.c" }), "ana");
}

console.log("studentIdentity tests passed");
