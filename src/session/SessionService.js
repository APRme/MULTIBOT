const SessionManager = require('./SessionManager');

class SessionService {
  constructor(sessionsDir) {
    this.manager = new SessionManager(sessionsDir);
  }

  load(email) {
    if (!email) return null;
    return this.manager.loadSession(email);
  }

  save(email, session) {
    if (!email || !session) return false;
    return this.manager.saveSession(email, session);
  }

  delete(email) {
    if (!email) return false;
    return this.manager.deleteSession(email);
  }

  getPath(email) {
    if (!email) return null;
    return this.manager.getSessionFilePath(email);
  }
}

module.exports = {
  SessionService
};
