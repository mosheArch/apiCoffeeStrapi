module.exports = {
    routes: [
        {
            method: "POST",
            path: "/payment-orden",
            handler: "orden.paymentOrder",
            config: {
                policies: [],
                middlewares: [],
            },
        },
    ],
};