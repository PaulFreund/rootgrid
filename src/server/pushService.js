import webPush from 'web-push'

export class PushService {
  /**
   * @param {{
   *   store: any,
   *   vapidKeys: { publicKey: string, privateKey: string },
   *   subject: string
   * }} opts
   */
  constructor({ store, vapidKeys, subject }) {
    this.store = store
    this.publicKey = vapidKeys.publicKey
    webPush.setVapidDetails(subject, vapidKeys.publicKey, vapidKeys.privateKey)
  }

  getPublicKey() {
    return this.publicKey
  }

  /**
   * @param {{ title: string, body: string, tag?: string, data?: any }} payload
   */
  async sendToAll(payload) {
    const subs = this.store.listPushSubscriptions()
    if (!subs.length) return { attempted: 0, delivered: 0 }

    const body = JSON.stringify(payload)
    let delivered = 0

    await Promise.all(subs.map(async (s) => {
      const pushSubscription = {
        endpoint: s.endpoint,
        keys: {
          p256dh: s.p256dh,
          auth: s.auth
        }
      }

      try {
        await webPush.sendNotification(pushSubscription, body)
        delivered += 1
      } catch (err) {
        const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : null
        if (statusCode === 410) {
          try { this.store.deletePushSubscription(s.endpoint) } catch { }
          return
        }
        console.error('[rootgrid] push send failed:', err)
      }
    }))

    return { attempted: subs.length, delivered }
  }
}

