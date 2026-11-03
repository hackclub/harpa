<script>
	import favicon from '#lib/assets/harpa.png';
	import "#lib/styles.css";

	let { children } = $props();
</script>

<svelte:head>
	<title>Harpa</title>
	<link rel="icon" href={favicon} />
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com">
	<link href="https://fonts.googleapis.com/css2?family=Darumadrop+One&family=Jua&display=swap" rel="stylesheet">
	<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0&icon_names=fullscreen,settings" />
</svelte:head>

{@render children()}
