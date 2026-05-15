class App {
    start(): void {
        console.log("hello");
    }

    stop(): void {
        console.log("bye");
    }
}

function bootstrap(): void {
    const app = new App();
    app.start();
}
