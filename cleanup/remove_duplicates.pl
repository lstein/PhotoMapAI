#!/usr/bin/perl

use strict;

$/ = "\n\n";
my $count = 0;
while (<>) {
    chomp;
    my ($hash, $first, @remaining) = split ("\n");
    for my $file (@remaining) {
	my $result = unlink $file;
	if (!$result) {
	    warn "Could not unlink $file: $!";
	    next;
	}
	$count++;
    }
}

print "Unlinked $count files\n";
exit 0;
