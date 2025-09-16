// This is a central registry for event listeners used in the application.
// Eventually all event listeners should be registered here for ease of management.

class EventRegistry {
  constructor() {
    // Namespaces for different modules
    this.handlers = {
      swiper: {},
      grid: {},
      umap: {},
      search: {},
      settings: {},
    };
  }

  // Remove all event listeners of a given type (namespace)
  removeAll(type) {
    const handlers = this.handlers[type];
    for (const [key, fn] of Object.entries(handlers)) {
      const { event, object } = this._parseKey(key);
      (object || window).removeEventListener(event, fn);
    }
    this.handlers[type] = {};
  }

  // Install a new event listener, replacing any existing one for the same event
  install(options, fn) {
    const { type, event, object = window } = options;
    const key = this._makeKey(event, object);
    this.remove({ type, event, object });
    object.addEventListener(event, fn);
    if (!this.handlers[type]) this.handlers[type] = {};
    this.handlers[type][key] = fn;
  }

  // Remove a specific event listener
  remove(options) {
    const { type, event, object = window } = options;
    const key = this._makeKey(event, object);
    if (this.handlers[type] && this.handlers[type][key]) {
      object.removeEventListener(event, this.handlers[type][key]);
      delete this.handlers[type][key];
    }
  }

  _makeKey(event, object) {
    if (object && object !== window) {
      if (!object.__eventRegistryId) {
        object.__eventRegistryId = Math.random().toString(36).slice(2);
      }
      return `${event}__${object.__eventRegistryId}`;
    }
    return event;
  }

  _parseKey(key) {
    const [event, objId] = key.split("__");
    let object = null;
    if (objId) {
      object = Array.from(document.querySelectorAll("*")).find(
        (el) => el.__eventRegistryId === objId
      ) || null;
    }
    return { event, object };
  }
}

// Singleton instance
if (!window.eventRegistry) {
  window.eventRegistry = new EventRegistry();
}

// Export the singleton for use in other modules
export const eventRegistry = window.eventRegistry;
