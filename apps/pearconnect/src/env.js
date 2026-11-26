// Loads ./.env like dotenv/config did (existing environment variables win). A missing file is fine.
try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
