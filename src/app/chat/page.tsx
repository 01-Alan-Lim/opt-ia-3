export default function ChatPage() {
  return (
    <main className="min-h-screen flex flex-col bg-slate-900 text-slate-100">
      <header className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <h1 className="font-semibold">
          OPT-IA 3 – Panel de chat
        </h1>
        <span className="text-xs text-slate-400">
          Aquí luego conectaremos Supabase + Google AI + login.
        </span>
      </header>

      <section className="flex-1 flex">
        {/* Sidebar futuro */}
        <aside className="hidden md:block w-64 border-r border-slate-800 p-4 text-sm">
          Historial de chats (placeholder)
        </aside>

        {/* Área de chat */}
        <div className="flex-1 flex flex-col p-4">
          <div className="flex-1 border border-slate-800 rounded-xl p-4 mb-4">
            <p className="text-slate-400 text-sm">
              Aquí mostraremos los mensajes del chat.
            </p>
          </div>
          <form className="flex gap-2">
            <input
              className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              placeholder="Escribe tu mensaje para OPT-IA..."
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-sky-500 text-sm font-medium hover:bg-sky-600 transition"
            >
              Enviar
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
