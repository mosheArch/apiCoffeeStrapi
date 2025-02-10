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
        {
            method: "PUT",
            path: "/ordens/:id/update-status",
            handler: "orden.updateOrderStatus",
            config: {
                policies: [],
                middlewares: [],
            },
        },
    ],
};