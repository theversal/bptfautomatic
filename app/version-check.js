// Make sure we're using a supported node.js version
if (process.versions && process.versions.node) {
    let parts = process.versions.node.split('.');
    if (parts[0] < 16) {
        console.log("FATAL ERROR: backpack.tf Automatic requires node.js version 16.0.0 or later.");
        console.log("Update here: https://nodejs.org/en/download/");
        process.exit(1);
    }
}