# Configuration

PhotoMap is primarily configured through the web interface as described in [Basic Usage](/user-guide/basic-usage#changing-settings) and [Albums](/user-guide/albums). However, there are a number of runtime parameters that control how the web service behaves.

## Changing the Web Host and Port

By default, PhotoMap runs its web service on port 8050 and only accepts connections on the local machine (`localhost`). These can be changed on the command line used to launch the application using the `--port` and `--host` options:

    start_photomap --port 8000 --host 0.0.0.0

This command changes the port to port 8000, and allows PhotoMap to listen for connections on the wildcard IP address `0.0.0.0`, meaning that it will accept connections for any network-accessible location.

If you are using a launcher script to start PhotoMap (e.g. `start_photomap.bat`) you can change these values by opening the script in a text editor (`Notepad` on Windows), finding the line containing `start_photomap`, and adding the options as shown above.

Alternatively, you can change the port and host interface by setting two environment variables prior to launching PhotoMap. These are:

* `PHOTOMAP_HOST` - the host interface to accept connections from
* `PHOTOMAP_PORT` - the listen port

On Linux and Macintosh systems, you can set these environment variables on the command line like so:

```bash
PHOTOMAP_HOST="0.0.0.0" PHOTOMAP_PORT="8000" start_photomap
```

Or you can permanently fix these environment variables by setting them in your shell's profile, e.g. `.bashrc`.

On Windows systems, setting environment variables can be done through the GUI as well as on the command line. See [How to Set Environment Variables in Windows](https://phoenixnap.com/kb/windows-set-environment-variable) for a good walkthrough.

## Pointing to an Alternative Configuration File

PhotoMap stores its album definitions and other configuration information in a configuration file. It is not usually necessary to manipulate it directly, but if you wish you can point to an alternative config file in order to have multiple PhotoMap servers each hosting separate album collections.

The config file is stored in different places depending on the platform:

| Platform         | Config File Path        |
|------------------|-------------------------|
| Linux            | ~/.config/photomap/config.yaml |
| MacOS            | ~/Library/Application Support/photomap/config.yaml |
| Windows          | C:\Users\<user>\AppData\Roaming\photomap\config.yaml|

To run PhotoMap off a different config file, you may launch it with the `--config` option on the command line, similar to setting the port and host. In the below example we specify an alternative config file named `photomap_2.yaml`

    start_photomap --config ~/photomap_2.yaml

If the indicated config file doesn't exist when you launch PhotoMap, it will be created automatically.

You may also point to an alternative configuration file by setting the environment variable `PHOTOMAP_CONFIG`, as described in the previous section:

```bash
PHOTOMAP_CONFIG=~/photomap_2.yaml start_photomap
```

It is also possible, but not recommended, to edit the configuration file directly using a text editor. The format is straightforward to understand, but liable to change in the future.
