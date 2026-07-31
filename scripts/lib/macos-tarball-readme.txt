Isolade for macOS
=================


"Isolade is damaged and can't be opened. You should move it to the Trash."
-------------------------------------------------------------------------

Nothing is wrong with the app, and you do not have to move it anywhere. Run
this, then open it again:

    xattr -dr com.apple.quarantine Isolade.app

Use the path to wherever the app now sits, and prefix the command with sudo if
that is inside /Applications and the copy there is owned by root.

macOS attaches a quarantine flag to anything a browser downloads, and Finder
passes that flag on to whatever it expands out of it. It then refuses to launch a
quarantined app unless Apple has notarized it. Isolade is signed, but with our
own certificate rather than an Apple Developer ID, so there is no notarization
for macOS to find. The command above removes the flag.


Skipping all of that
--------------------

    curl -fsSL https://isolade.com/install.sh | sh

That is the recommended way to install Isolade, and to update it later. It
fetches and unpacks the app without a browser, so the flag is never attached in
the first place. https://isolade.com/docs/installation covers what it does, and
how to do the same by hand if you would rather not run a script.


Requirements
------------

An Apple Silicon Mac. The VMs use Apple's own Hypervisor framework, which ships
with macOS, so there is nothing else to install.


Docs:   https://isolade.com/docs
Source: https://github.com/isolade/isolade
