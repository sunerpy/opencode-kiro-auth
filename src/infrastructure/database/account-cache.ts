export class AccountCache {
  private cache = new Map<string, any>()
  private allAccountsCache: any[] | null = null
  private lastUpdate = 0
  private ttl: number

  constructor(ttlMs: number = 60000) {
    this.ttl = ttlMs
  }

  getAll(): any[] | null {
    if (this.isExpired()) {
      return null
    }
    return this.allAccountsCache ? [...this.allAccountsCache] : null
  }

  setAll(accounts: any[]): void {
    this.allAccountsCache = [...accounts]
    this.lastUpdate = Date.now()
    for (const acc of accounts) {
      this.cache.set(acc.id, acc)
    }
  }

  get(id: string): any | null {
    if (this.isExpired()) {
      return null
    }
    return this.cache.get(id) || null
  }

  set(id: string, account: any): void {
    this.cache.set(id, account)
    this.lastUpdate = Date.now()
  }

  invalidate(id: string): void {
    this.cache.delete(id)
    this.allAccountsCache = null
  }

  invalidateAll(): void {
    this.cache.clear()
    this.allAccountsCache = null
    this.lastUpdate = 0
  }

  private isExpired(): boolean {
    return Date.now() - this.lastUpdate > this.ttl
  }
}
