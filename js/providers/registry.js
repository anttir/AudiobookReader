/**
 * Provider registry — discoverable list of storage providers and the
 * currently active source.
 *
 * Adding a new provider:
 *   1. Implement it on top of ProviderBase
 *   2. Append it to Providers._all in the order it should appear in the UI
 *   3. Its id must be unique across providers
 */

const Providers = {
    _all: [],
    _activeId: null,

    register(provider) {
        if (!provider?.id) throw new Error('Provider must define an id');
        if (this._all.some(p => p.id === provider.id)) {
            throw new Error(`Provider already registered: ${provider.id}`);
        }
        this._all.push(provider);
        if (!this._activeId) this._activeId = provider.id;
    },

    /** All registered providers, in registration order. */
    list() { return this._all.slice(); },

    /** Look up a provider by id. */
    get(id) { return this._all.find(p => p.id === id) || null; },

    /** Currently active provider (the one that drives the library view). */
    active() { return this.get(this._activeId); },

    activeId() { return this._activeId; },

    setActive(id) {
        if (!this.get(id)) throw new Error(`Unknown provider: ${id}`);
        this._activeId = id;
        Storage.setSettings({ activeSourceId: id });
    },

    /**
     * Initialise from saved settings. Falls back to the first registered
     * provider. Safe to call once on app boot, after all providers have
     * been registered.
     */
    restoreActive() {
        const saved = Storage.getSettings()?.activeSourceId;
        if (saved && this.get(saved)) {
            this._activeId = saved;
        } else if (this._all.length > 0) {
            this._activeId = this._all[0].id;
        }
        return this.active();
    },
};

// Register built-in providers. Order here determines UI order.
if (typeof DriveProvider !== 'undefined') {
    Providers.register(DriveProvider);
}
if (typeof R2Provider !== 'undefined') {
    Providers.register(R2Provider);
}
