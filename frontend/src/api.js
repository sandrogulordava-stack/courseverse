const API = import.meta.env.VITE_API_URL || 'http://localhost:5000';
export const apiBase = API;
export function token() { return localStorage.getItem('courseverse_token'); }
export async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const res = await fetch(`${API}/api${path}`, { ...options, headers, body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
export const fallbackAvatar = seed => `https://api.dicebear.com/8.x/avataaars/svg?seed=${encodeURIComponent(seed || 'user')}`;
export const fallbackCourse = 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=1200';
