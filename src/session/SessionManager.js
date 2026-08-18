const fs = require('fs');
const path = require('path');

class SessionManager {
  constructor(sessionsDir = './sessions') {
    this.sessionsDir = sessionsDir;
    this.ensureDir();
  }

  ensureDir() {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  getSessionFilePath(email) {
    if (!email || typeof email !== 'string') {
      throw new Error('Email must be a non-empty string');
    }

    const safeName = email.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.sessionsDir, `${safeName}.json`);
  }

  isValidSessionStructure(session) {
    if (!session || typeof session !== 'object') {
      return false;
    }

    const hasAccessToken = session.accessToken && typeof session.accessToken === 'string';
    const hasSelectedProfile = session.selectedProfile &&
      session.selectedProfile.id &&
      session.selectedProfile.name;

    return Boolean(hasAccessToken && hasSelectedProfile);
  }

  loadSession(email) {
    try {
      const filePath = this.getSessionFilePath(email);
      if (!fs.existsSync(filePath)) {
        return null;
      }

      const data = fs.readFileSync(filePath, 'utf8');
      const session = JSON.parse(data);

      if (this.isValidSessionStructure(session)) {
        return session;
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  saveSession(email, session) {
    try {
      if (!this.isValidSessionStructure(session)) {
        return false;
      }

      this.ensureDir();
      const filePath = this.getSessionFilePath(email);
      const sessionData = {
        ...session,
        _metadata: {
          savedAt: new Date().toISOString(),
          email
        }
      };

      fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2), 'utf8');
      return true;
    } catch (error) {
      return false;
    }
  }

  deleteSession(email) {
    try {
      const filePath = this.getSessionFilePath(email);
      if (!fs.existsSync(filePath)) {
        return false;
      }

      fs.unlinkSync(filePath);
      return true;
    } catch (error) {
      return false;
    }
  }

  listSessions() {
    try {
      if (!fs.existsSync(this.sessionsDir)) {
        return [];
      }

      return fs.readdirSync(this.sessionsDir)
        .filter((fileName) => fileName.endsWith('.json'))
        .map((fileName) => {
          try {
            const payload = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, fileName), 'utf8'));
            return {
              file: fileName,
              email: payload._metadata?.email || fileName.replace(/\.json$/i, ''),
              savedAt: payload._metadata?.savedAt || null,
              hasAccessToken: Boolean(payload.accessToken),
              profile: payload.selectedProfile?.name || null
            };
          } catch (error) {
            return null;
          }
        })
        .filter(Boolean);
    } catch (error) {
      return [];
    }
  }

  cleanupExpiredSessions() {}
}

module.exports = SessionManager;
