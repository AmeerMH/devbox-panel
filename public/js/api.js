/** Thin fetch wrapper: carries the CSRF header and bounces to /login on 401. */
export const api = {
  csrf: null,

  async request(path, { method = 'GET', body } = {}) {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (this.csrf && method !== 'GET') headers['x-panel-csrf'] = this.csrf

    const res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    if (res.status === 401) {
      location.href = '/login'
      throw new Error('Not signed in')
    }
    const text = await res.text()
    let data = {}
    try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
    if (!res.ok) {
      const err = new Error(data.error || `${method} ${path} failed (${res.status})`)
      err.status = res.status
      err.data = data
      throw err
    }
    return data
  },

  get(path) { return this.request(path) },
  post(path, body) { return this.request(path, { method: 'POST', body }) },

  async init() {
    const me = await this.get('/me')
    this.csrf = me.csrf
    return me
  },
}
