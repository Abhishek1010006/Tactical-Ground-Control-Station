# SwarmGCS Requirements Installer

Run `install_windows.bat` on a new Windows machine before starting the app.

What it does:

- Checks for Python 3.
- Downloads and installs Python 3.12 for the current user if Python is missing.
- Installs the Python packages from `../requirements.txt`.
- Checks for Node.js/npm.
- Downloads portable Node.js into `requirements/runtime` if Node.js is missing.
- Runs `npm install` inside `../electron`.
- Creates `../Run_SwarmGCS_Portable.bat`, which starts the app using the bundled Node runtime.

After installation, start the app with:

```bat
Run_SwarmGCS_Portable.bat
```

The installer needs internet access only while downloading Python, Node.js, and package dependencies.
