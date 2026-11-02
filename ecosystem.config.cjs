module.exports = {
  apps: [
    {
      name: 'defectos-calidad-api',
      cwd: 'C:\\App\\Joel\\10_proyecto_calidad\\backend',
      // Ruta absoluta al binario real de Bun en este entorno
      script: 'C:\\Users\\MBCPROEW10028\\.bun\\bin\\bun.exe',
      // Argumentos para ejecutar el punto de entrada TypeScript con Bun
      args: 'run src/index.ts',
      // Sin intérprete externo: Bun ejecuta directamente
      interpreter: 'none',
      exec_mode: 'fork',
      shutdown_with_message: true,
      watch: false,
      env: {
        NODE_ENV: 'development',
        TZ: 'America/Mexico_City',
      },
      env_development: {
        NODE_ENV: 'development',
        TZ: 'America/Mexico_City',
      },
      // Gestión de resiliencia y recuperación automática
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 8000,
      // Registro y separación de logs del backend de desarrollo
      out_file: 'C:\\App\\Joel\\10_proyecto_calidad\\backend\\logs\\out.log',
      error_file: 'C:\\App\\Joel\\10_proyecto_calidad\\backend\\logs\\error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
