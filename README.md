# Martini Shot

Martini Shot is a local-first Electron control plane for the Martini Shot ComfyUI nodes. The application will manage projects, reports, local assets, and staged ComfyUI workflow execution.

## Development

1. Run `npm install`.
2. Run `npm run dev`.

On first launch, Martini Shot automatically creates its local SQLite database at `%APPDATA%\Martini Shot\martini-shot.db`. No database server, password, port, or `.env` file is required. The `.env.example` file is optional and only lets developers override the local ComfyUI address or SQLite data folder.

## Windows distribution

Run `npm run dist`. electron-builder writes an NSIS installer to `release/`.

The installed app needs only a locally running ComfyUI instance. Martini Shot manages its own small local project database; it does not start, update, or bundle ComfyUI or its models.
