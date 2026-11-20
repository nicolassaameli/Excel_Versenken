// Supabase-Zugangsdaten
// Zu finden im Supabase-Dashboard unter: Project Settings -> API
// Der "anon public" Key darf öffentlich sein (er steht ohnehin im Browser).
// Die Sicherheit kommt aus den RLS-Regeln und Funktionen in supabase/schema.sql.
window.ZV_CONFIG = {
  SUPABASE_URL: "",       // z. B. "https://abcdefghijkl.supabase.co"
  SUPABASE_ANON_KEY: "",  // z. B. "eyJhbGciOi..."
};
