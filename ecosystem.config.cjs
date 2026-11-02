module.exports = {
  apps: [
    {
      name: 'defectos-calidad-api',
      cwd: 'C:\\Servidor\\Aplicaciones\\Calidad-MBC\\Backend\\backend-calidad',
      // Ruta absoluta al binario real de Bun en el servidor Windows Server 2025
      script: 'C:\\Users\\joel.rodriguez\\.bun\\bin\\bun.exe',
      // Argumentos para ejecutar el punto de entrada TypeScript con Bun
      args: 'run src/index.ts',
      // Sin intérprete externo: Bun ejecuta directamente
      interpreter: 'none',
      exec_mode: 'fork',
      shutdown_with_message: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        TZ: 'America/Mexico_City',
      },
      env_production: {
        NODE_ENV: 'production',
        TZ: 'America/Mexico_City',
      },
      // Gestión de resiliencia y recuperación automática
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 8000,
      // Registro y separación de logs en el servidor
      out_file: 'C:\\Servidor\\Logs\\Aplicaciones\\Calidad-MBC\\out.log',
      error_file: 'C:\\Servidor\\Logs\\Aplicaciones\\Calidad-MBC\\error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
