const a = false;

async function produce() {
	if (a) {
		return null;
	}
	return {
		one: undefined,
		two: "value",
	};
}

const prod = await produce();
console.log(prod);
