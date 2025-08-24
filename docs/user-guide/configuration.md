# Configuration

PhotoMapAI is primarily configured through the web interface as described in [Basic Usage](user-guide/basic-usage.md#changing-settings) and [Albums](user-guide/albums.md). However, there are a number of runtime parameters that control how the web service behaves.

## Changing the Web Host and Port

By default, PhotoMapAI runs its web service on port 8050 and only accepts connections on the local machine (`localhost`). These can be changed on the command line used to launch the application using the `--port` and `--host` options:

    start_photomap --port 8000 --host 0.0.0.0

This command changes the port to port 8000, and allows PhotoMapAI to listen for connections on the wildcard IP address `0.0.0.0`, meaning that it will accept connections for any network-accessible location.

If you are using a launcher script to start PhotoMapAI (e.g. `start_photomap.bat`) you can change these values by opening the script in a text editor (`Notepad` on Windows), finding the line containing `start_photomap`, and adding the options as shown above.

Alternatively, you can change the port and host interface by setting two environment variables prior to launching PhotoMapAI. These are:

* `PHOTOMAP_HOST` - the host interface to accept connections from
* `PHOTOMAP_PORT` - the listen port

On Linux and Macintosh systems, you can set these environment variables on the command line like so:

```bash
PHOTOMAP_HOST="0.0.0.0" PHOTOMAP_PORT="8000" start_photomap
```

Or you can permanently fix these environment variables by setting them in your shell's profile, e.g. `.bashrc`.

On Windows systems, setting environment variables can be done through the GUI as well as on the command line. See [How to Set Environment Variables in Windows](https://phoenixnap.com/kb/windows-set-environment-variable) for a good walkthrough.

## Running PhotoMapAI Under HTTPS

By default, PhotoMapAI runs as a non-secure `HTTP` service. This generates a warning icon in some browsers, but more seriously prevents cut and paste between the PhotoMapAI tab and browser tabs and desktop applications. 

There are several ways to enable HTTP for PhotoMapAI:

### Install a Self-Signed SSL Certificate

In this method, you generate self-signed encryption certificate and
private key files and point PhotoMapAI to them using its `--cert` and
`--key` command-line options.

Guides to generating and installing self-signed certificates:

- [Creating Self-Signed Certificates with Windows PowerShell](https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-self-signed-certificate). Please apply the arguments to create .crt and .pem files.

- [Creating Self-Signed Certificates with OpenSSL (Mac/Linux)](https://gist.github.com/elklein96/a15090f35a41e16bdc8574a7fb81e119)

These methods will leave you with two files, a .crt certificate file,
and a .pem key file. Relaunch the PhotoMapAI server using `--cert
/path/to/.crt file` and `--key /path/to/.pem file`. If you are using
the desktop launcher to start the server, simply open the launcher
file with a text editor, and add the `--cert` and `--key` options to
the end of the line that ends with `start_photomap`.

After installing the certificate/key pair and relaunching the server,
you will be able to access the PhotoMapAI server using the https://
URL. Your browser will complain about an unknown certificate authority
when you first load the URL and ask you to confirm that you trust the site.

### Use Certbot

The [Certbot](https://certbot.eff.org/) tool provides public certificates that
browsers automatically trust. It is very easy to use, but it requires that you
have a web running on port 80 that accepts incoming HTTP connections.

Once the Certbot certificate and keyfile are generated, follow the
directions in the previous section to configure PhotoMapAI to use them.


### Use a Reverse Proxy

A final option is to keep PhotoMapAI running on HTTP, but use a reverse
proxy from a running web server to translate HTTPS requests on the
reverse proxy into HTTP requests to PhotoMapAI. The main advantage of this
is that you get the additional benefit of all the web server's configuration
controls, such as the ability to add password protection.

Here are some guides for setting up reverse proxies. The first is a
general guide for configuring a reverse proxy with the popular Nginx
web server. The second features a Windows-specific walkthrough.

- [NGINX Reverse Proxy](https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/)
- [NGINX Reverse Proxy on Windows](https://virendra.dev/blog/setting-up-nginx-as-a-reverse-proxy-on-windows)

You will need to install encryption certificates for the Nginx server using [Certbot](https://certbot.eff.org/). The final configuration of the proxy server will look something like this:

    	location /photomap/ {
        proxy_pass http://localhost:8050/;

This is saying that when a request comes in for
`https://your.host/photomap/` it will be translated into a request to
`http://localhost:8050/` where PhotoMapAI is running. It is possible to
run the proxy server and the PhotoMapAI server on separate machines as well.

## Pointing to an Alternative Configuration File

PhotoMapAI stores its album definitions and other configuration information in a configuration file. It is not usually necessary to manipulate it directly, but if you wish you can point to an alternative config file in order to have multiple PhotoMapAI servers each hosting separate album collections.

The config file is stored in different places depending on the platform:

| Platform         | Config File Path        |
|------------------|-------------------------|
| Linux            | ~/.config/photomap/config.yaml |
| MacOS            | ~/Library/Application Support/photomap/config.yaml |
| Windows          | C:\Users\<user>\AppData\Roaming\photomap\config.yaml|

To run PhotoMapAI off a different config file, you may launch it with the `--config` option on the command line, similar to setting the port and host. In the below example we specify an alternative config file named `photomap_2.yaml`

    start_photomap --config ~/photomap_2.yaml

If the indicated config file doesn't exist when you launch PhotoMapAI, it will be created automatically.

You may also point to an alternative configuration file by setting the environment variable `PHOTOMAP_CONFIG`, as described in the previous section:

```bash
PHOTOMAP_CONFIG=~/photomap_2.yaml start_photomap
```

It is also possible, but not recommended, to edit the configuration file directly using a text editor. The format is straightforward to understand, but liable to change in the future.
